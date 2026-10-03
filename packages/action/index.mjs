#!/usr/bin/env node
/**
 * ShipReady GitHub Action entry point.
 *
 * `action.yml` runs this file. It is a thin wrapper around the CLI: the action's
 * job is to resolve inputs, decide the exit code, publish outputs and post the
 * pull-request comment. Everything it checks lives in the CLI, so the behaviour
 * is identical whether you run it from a workflow or from a terminal.
 *
 * Exit codes are a published contract:
 *   0  the gate passed
 *   1  the gate failed (below threshold, or a blocker appeared)
 *   2  the action could not run at all
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Read an `INPUT_*` variable, as the Actions runner supplies them. */
function input(name, fallback = undefined) {
  const key = `INPUT_${name.replace(/[ -]/g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function flag(name, fallback = false) {
  const value = input(name);
  if (value === undefined) return fallback;
  return /^(true|1|yes|on)$/i.test(String(value).trim());
}

function number(name, fallback) {
  const parsed = Number.parseFloat(input(name, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const log = (message) => process.stdout.write(`${message}\n`);
const group = (title) => log(`::group::${title}`);
const endGroup = () => log('::endgroup::');
const warning = (message) => log(`::warning::${message}`);
const failure = (message) => log(`::error::${message}`);

/**
 * Write an action output.
 *
 * `GITHUB_OUTPUT` is the current mechanism; the `::set-output::` fallback is
 * for self-hosted runners on an older Actions version.
 */
function setOutput(name, value) {
  const key = `SHIPREADY_OUTPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  } else {
    log(`::set-output name=${name}::${value}`);
  }
}

/**
 * The CLI entry point.
 *
 * Searched in order of specificity: next to this file (installed alongside the
 * action), two levels up (running from the monorepo checkout), then in
 * node_modules. Walking up rather than hardcoding a relative path means the
 * action works whether it is consumed from the repository or installed.
 */
function resolveCli() {
  const candidates = [];
  let dir = here;
  for (let depth = 0; depth < 5; depth++) {
    candidates.push(join(dir, 'cli', 'bin', 'shipready.mjs'));
    candidates.push(join(dir, 'node_modules', '@shipready', 'cli', 'bin', 'shipready.mjs'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(join(process.cwd(), 'node_modules', '@shipready', 'cli', 'bin', 'shipready.mjs'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run the CLI and return its exit code and output. */
function runCli(args) {
  return new Promise((done) => {
    const child = spawnNode(args);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
      process.stdout.write(c);
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
      process.stderr.write(c);
    });
    child.on('error', (err) => done({ code: 2, stdout, stderr: String(err.message) }));
    child.on('close', (code) => done({ code: code ?? 2, stdout, stderr }));
  });
}

function spawnNode(args) {
  return spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

async function main() {
  const workingDirectory = input('working-directory');
  if (workingDirectory) process.chdir(resolve(workingDirectory));

  const target = resolve(input('path', '.') ?? '.');
  if (!existsSync(target)) {
    failure(`Path "${target}" does not exist`);
    process.exitCode = 2;
    return;
  }

  const cli = resolveCli();
  if (!cli) {
    failure(
      'Could not find the ShipReady CLI. Install it with `npm i -D @shipready/cli`, or check out this repository.',
    );
    process.exitCode = 2;
    return;
  }

  const threshold = number('threshold', 50);
  const baseline = flag('baseline', false);
  const failOn = input('fail-on', 'blocker');
  const output = input('output');
  const sarifOutput = input('sarif-output');
  const comment = flag('comment', true);
  const annotations = flag('annotations', true);
  const baselineFile = input('baseline-file');

  const args = [cli, 'scan', target, '--format', input('format', 'github')];
  args.push('--threshold', String(threshold), '--fail-on', failOn);
  if (baseline) args.push('--baseline');
  if (annotations) args.push('--annotations');
  if (output) args.push('--output', output);

  group('ShipReady: production readiness');
  const result = await runCli(args);
  endGroup();

  // Read the saved report: outputs and the PR comment come from one source, so
  // they can never disagree.
  const report = readReport(target);

  if (report) {
    setOutput('score', String(report.score));
    setOutput('grade', report.grade);
    setOutput('verdict', report.verdict);
    setOutput('blockers', String(report.summary?.blockers ?? 0));
    setOutput('fixable', String(report.summary?.fixable ?? 0));
    setOutput('time-to-launch', report.summary?.estimatedTimeToLaunch ?? 'unknown');
    for (const category of report.categories ?? []) {
      setOutput(`category-${category.category}`, String(category.score));
    }
    writeStepSummary(report);
    if (comment) await postOrUpdateComment(report, baselineFile);
  }

  if (sarifOutput) {
    // SARIF is a second scan because the human-facing format and the machine
    // format are different reports, not one report rendered twice.
    mkdirSync(dirname(resolve(sarifOutput)), { recursive: true });
    const sarif = await runCli([
      cli,
      'scan',
      target,
      '--format',
      'sarif',
      '--output',
      sarifOutput,
      '--fail-on',
      'never',
      '--quiet',
    ]);
    if (sarif.code === 2) {
      warning(`Could not write SARIF to ${sarifOutput}`);
    } else {
      setOutput('sarif-path', sarifOutput);
      log(`SARIF written to ${sarifOutput}`);
    }
  }

  if (result.code === 1) {
    const reason = !report
      ? 'the readiness gate failed'
      : baseline
        ? 'readiness regressed, or a new launch blocker appeared'
        : `score ${report.score}/100 is below the threshold of ${threshold}`;
    failure(`ShipReady: ${reason}`);
    process.exitCode = 1;
    return;
  }

  if (result.code === 2) {
    failure('ShipReady: the scan could not run');
    process.exitCode = 2;
    return;
  }

  if (report) log(`ShipReady: ${report.score}/100 (${report.grade}) - ${report.verdict}`);
}

function readReport(target) {
  const path = join(target, '.shipready', 'last-scan.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    warning('Could not read the saved report; continuing with the exit code alone.');
    return null;
  }
}

/** The job summary is where a reviewer actually looks first. */
function writeStepSummary(report) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const icon = {
    'PRODUCTION READY': ':white_check_mark:',
    'READY WITH CAVEATS': ':large_yellow_circle:',
    'NEEDS WORK': ':orange_circle:',
    'NOT READY': ':red_circle:',
  }[report.verdict] ?? ':grey_question:';

  const hours = (minutes) => `${Math.round((minutes / 60) * 10) / 10}h`;
  const lines = [
    `## ${icon} ShipReady: ${report.verdict}`,
    '',
    `**Score ${report.score}/100** (${report.grade}) · ${report.summary.totalFindings} findings · ${report.summary.blockers} blocker(s) · ~${report.summary.estimatedTimeToLaunch} to launch readiness`,
    '',
    '| Category | Score | Blockers | Findings |',
    '|---|---:|---:|---:|',
    ...[...report.categories]
      .sort((a, b) => a.score - b.score)
      .map((c) => `| ${c.label} | ${c.score} | ${c.blockers || '—'} | ${c.findingCount} |`),
    '',
  ];

  if (report.topBlockers.length > 0) {
    lines.push('### Fix before launch', '');
    for (const [i, blocker] of report.topBlockers.entries()) {
      lines.push(
        `${i + 1}. **${blocker.title}** — \`${blocker.path}:${blocker.line}\` (~${hours(blocker.effortMinutes)})`,
      );
      lines.push(`   ${blocker.remediation}`);
    }
    lines.push('');
  }
  appendFileSync(file, lines.join('\n'));
}

/** Post the readiness report as a PR comment, updating the previous one. */
async function postOrUpdateComment(report, baselineFile) {
  const token = input('token', process.env.GITHUB_TOKEN);
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER ?? readPrNumberFromEvent();

  if (!token || !repository || !number) {
    // Not a pull request. Persist the report so `--baseline` has something to
    // compare against on the next run.
    if (baselineFile) {
      mkdirSync(dirname(resolve(baselineFile)), { recursive: true });
      writeFileSync(baselineFile, JSON.stringify(report, null, 2), 'utf8');
    }
    log('Not a pull request; wrote the report to the baseline file instead.');
    return;
  }

  const marker = '<!-- shipready-readiness -->';
  const body = [
    marker,
    `### ${report.verdict === 'PRODUCTION READY' ? ':white_check_mark:' : report.verdict === 'NOT READY' ? ':red_circle:' : ':large_yellow_circle:'} ShipReady: ${report.verdict}`,
    '',
    `**${report.score}/100** (${report.grade}) · ${report.summary.blockers} blocker(s) · ${report.summary.fixable} auto-fixable · ~${report.summary.estimatedTimeToLaunch} to launch readiness`,
    '',
    '| Category | Score |',
    '|---|---:|',
    ...[...report.categories]
      .sort((a, b) => a.score - b.score)
      .slice(0, 6)
      .map((c) => `| ${c.label} | ${c.score} |`),
    '',
    ...(report.topBlockers.length > 0
      ? [
          '**Fix before launch**',
          '',
          ...report.topBlockers.slice(0, 3).map((b, i) => `${i + 1}. **${b.title}** — \`${b.path}:${b.line}\``),
          '',
        ]
      : []),
    '<details><summary>All findings</summary>',
    '',
    ...report.findings.slice(0, 30).map((f) => `- ${f.severity} \`${f.location.path}:${f.location.startLine}\` ${f.title}`),
    '',
    '</details>',
  ].join('\n');

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'shipready-action',
  };

  const existing = await callApi(`${apiUrl}/repos/${repository}/issues/${number}/comments`, headers);
  const previous = Array.isArray(existing)
    ? existing.find((c) => String(c?.body ?? '').includes(marker))
    : undefined;

  if (previous) {
    await callApi(`${apiUrl}/repos/${repository}/issues/comments/${previous.id}`, headers, 'PATCH', { body });
    log('Updated the existing ShipReady comment.');
  } else {
    await callApi(`${apiUrl}/repos/${repository}/issues/${number}/comments`, headers, 'POST', { body });
    log('Posted a ShipReady comment.');
  }
}

function readPrNumberFromEvent() {
  return /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')?.[1];
}

async function callApi(url, headers, method = 'GET', body) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      warning(`GitHub API returned ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    warning(`Could not reach the GitHub API: ${error.message}`);
    return null;
  }
}

main().catch((error) => {
  failure(`ShipReady action failed: ${error?.stack ?? error}`);
  process.exitCode = 2;
});