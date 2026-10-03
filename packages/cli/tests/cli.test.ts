import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram, getExitCode, main, VERSION } from '../src/program.js';
import { parseConfig, DEFAULT_CONFIG, toScanConfig } from '../src/config.js';
import { runInit } from '../src/commands/init.js';
import { exitCodeFor } from '../src/commands/scan.js';
import type { ProductionReadinessReport } from '@shipready/core';

/** A deliberately vulnerable Express app: no tests, no CI, no Dockerfile. */
const VULNERABLE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'svc',
    version: '1.0.0',
    dependencies: { express: '4.19.2', '@prisma/client': '5.0.0' },
    scripts: { start: 'node src/index.js' },
  }),
  'src/index.js': [
    "const express = require('express');",
    "const { prisma } = require('./db');",
    'const app = express();',
    'app.get(\'/dashboard\', async (req, res) => {',
    '  const users = await prisma.user.findMany();',
    '  res.json(users);',
    '});',
    'app.post(\'/export\', async (req, res) => {',
    '  const { text } = req.body;',
    '  const summary = await runModel(text);',
    '  await prisma.summary.create({ data: { content: summary } });',
    '  res.json({ ok: true });',
    '});',
    'app.listen(3000);',
  ].join('\n'),
  'src/db.js': "const { PrismaClient } = require('@prisma/client');\nmodule.exports = { prisma: new PrismaClient() };\n",
  'src/model.js': "async function runModel(text) { const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ text }) }); return (await r.json()).summary; }\nmodule.exports = { runModel };\n",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-cli-'));
  for (const [path, content] of Object.entries(VULNERABLE)) {
    const abs = join(dir, path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run a command through main and return its exit code. */
async function run(...args: string[]): Promise<number> {
  return main(['node', 'shipready', ...args]);
}

describe('the program', () => {
  it('has a version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes every documented command', () => {
    const names = createProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    for (const command of ['scan', 'fix', 'report', 'init', 'rules', 'config', 'check', 'observe']) {
      expect(names, command).toContain(command);
    }
  });

  it('scans a directory and reports a low score', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'shipready', 'scan', dir, '--no-color', '--format', 'summary']);
    const code = getExitCode();
    // Vulnerable fixture with no CI, so the exit code must be 1.
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on never', async () => {
    const code = await run('scan', dir, '--no-color', '--format', 'summary', '--fail-on', 'never');
    expect(code).toBe(0);
  });

  it('writes a SARIF report', async () => {
    const out = join(dir, 'report.sarif');
    await run('scan', dir, '--no-color', '--format', 'sarif', '--output', out);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(await readFile(out, 'utf8'));
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    expect(parsed.runs[0].results.length).toBeGreaterThan(0);
  });

  it('rejects a path that does not exist', async () => {
    const code = await run('scan', join(dir, 'nope'), '--no-color', '--format', 'summary');
    expect(code).toBe(2);
  });

  it('lists the rule catalogue', async () => {
    expect(await run('rules', '--json', '--no-color')).toBe(0);
  });

  it('filters rules by category', async () => {
    expect(await run('rules', '--category', 'security', '--json', '--no-color')).toBe(0);
  });

  it('shows the resolved config', async () => {
    expect(await run('config', '--no-color')).toBe(0);
  });
});

describe('shipready fix', () => {
  it('plans fixes without writing by default', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'shipready', 'fix', dir, '--no-color']);
    expect(getExitCode()).toBe(0);
    expect(existsSync(join(dir, 'Dockerfile'))).toBe(false);
  });

  it('writes files with --apply', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'shipready', 'fix', dir, '--apply', '--no-color']);
    expect(existsSync(join(dir, 'Dockerfile'))).toBe(true);
    const dockerfile = await readFile(join(dir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('USER app');
  });

  it('is idempotent', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'shipready', 'fix', dir, '--apply', '--no-color']);
    const first = await readFile(join(dir, 'Dockerfile'), 'utf8');
    await program.parseAsync(['node', 'shipready', 'fix', dir, '--apply', '--no-color']);
    const second = await readFile(join(dir, 'Dockerfile'), 'utf8');
    expect(second).toBe(first);
  });
});

describe('shipready init', () => {
  it('writes a CI workflow, a config and npm scripts', async () => {
    const result = await runInit({ ci: true, force: false, threshold: 65, cwd: dir });
    expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(join(dir, '.shipready.yml'))).toBe(true);

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.readiness).toBe('shipready scan .');
    expect(pkg.scripts['readiness:ci']).toContain('--threshold 65');

    expect(result.created.length).toBeGreaterThanOrEqual(3);
    expect(result.nextSteps.length).toBeGreaterThan(0);

    const workflow = await readFile(join(dir, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('shipready scan');
    expect(workflow).toContain('--threshold 65');
    expect(workflow).toContain('upload-sarif');
  });

  it('never overwrites an existing pipeline', async () => {
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, '.github/workflows/ci.yml'), 'name: Existing\n', 'utf8');

    const result = await runInit({ ci: true, force: false, threshold: 50, cwd: dir });
    expect(await readFile(join(dir, '.github/workflows/ci.yml'), 'utf8')).toBe('name: Existing\n');
    const skipped = result.skipped.find((s) => s.path === '.github/workflows/ci.yml');
    expect(skipped?.reason).toContain('already configured');
  });

  it('overwrites only with --force', async () => {
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, '.github/workflows/ci.yml'), 'name: Existing\n', 'utf8');
    await runInit({ ci: true, force: true, threshold: 50, cwd: dir });
    expect(await readFile(join(dir, '.github/workflows/ci.yml'), 'utf8')).toContain('shipready scan');
  });

  it('adds .shipready to .gitignore', async () => {
    await runInit({ ci: false, force: false, threshold: 50, cwd: dir });
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.shipready/');
  });

  it('is safe to run twice', async () => {
    await runInit({ ci: true, force: false, threshold: 50, cwd: dir });
    const second = await runInit({ ci: true, force: false, threshold: 50, cwd: dir });
    expect(second.created.filter((f) => f.path === '.github/workflows/ci.yml')).toHaveLength(0);
  });
});

describe('config parsing', () => {
  it('returns defaults with no file', () => {
    expect(DEFAULT_CONFIG.scan.threshold).toBe(50);
    expect(DEFAULT_CONFIG.observe.costBudget).toBe(10);
  });

  it('maps onto the engine config', () => {
    const scan = toScanConfig({ ...DEFAULT_CONFIG, scan: { ...DEFAULT_CONFIG.scan, disable: ['x'] } });
    expect(scan.disableRules).toEqual(['x']);
  });

  it('parses a full config', () => {
    const { config, warnings } = parseConfig(
      [
        'version: 1',
        'scan:',
        '  threshold: 70',
        '  disable:',
        '    - a/b',
        'fix:',
        '  limit: 3',
        'observe:',
        '  costBudget: 5.5',
        'compliance:',
        '  jurisdiction: UK',
      ].join('\n'),
    );
    expect(config.scan.threshold).toBe(70);
    expect(config.scan.disable).toEqual(['a/b']);
    expect(config.fix.limit).toBe(3);
    expect(config.observe.costBudget).toBe(5.5);
    expect(config.compliance.jurisdiction).toBe('UK');
    expect(warnings).toEqual([]);
  });

  it('rejects an out-of-range threshold', () => {
    const { config, warnings } = parseConfig('scan:\n  threshold: 900\n');
    expect(config.scan.threshold).toBe(50);
    expect(warnings.length).toBe(1);
  });

  it('rejects an out-of-range confidence', () => {
    const { warnings } = parseConfig('scan:\n  minConfidence: 5\n');
    expect(warnings.join(' ')).toContain('0-1');
  });

  it('warns about a future version and still loads', () => {
    const { config, warnings } = parseConfig('version: 42\nscan:\n  threshold: 60\n');
    expect(config.scan.threshold).toBe(60);
    expect(warnings.join(' ')).toContain('version 42');
  });

  it('falls back on invalid YAML', () => {
    const { config, warnings } = parseConfig('scan:\n  - broken\n');
    expect(config.scan.threshold).toBe(50);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('ignores comments', () => {
    const { config } = parseConfig('# a comment\nscan:\n  threshold: 65  # inline\n');
    expect(config.scan.threshold).toBe(65);
  });
});

describe('exit codes', () => {
  function blockerStub() {
    return {
      id: 'b1',
      ruleId: 'readiness/security/no-rate-limiting',
      title: 'No rate limiting',
      severity: 'critical',
      productionImpact: 'blocker',
      confidence: 0.9,
      path: 'src/app.ts',
      line: 1,
      effortMinutes: 60,
      fixable: true,
    } as const;
  }

  function comparison(over: {
    previousScore: number;
    scoreDelta: number;
    regressions: readonly unknown[];
  }) {
    return {
      previousScore: over.previousScore,
      scoreDelta: over.scoreDelta,
      newFindings: 1,
      resolvedFindings: 0,
      blockersDelta: over.regressions.length,
      categoryDeltas: [],
      regressions: over.regressions as never[],
      improvements: [],
      ...(over.previousScore === 0 ? {} : { previousRunAt: '2026-01-01T00:00:00.000Z' }),
    };
  }

  function report(score: number, blockers: number): ProductionReadinessReport {
    return {
      version: 1,
      score,
      grade: 'B',
      verdict: blockers > 0 ? 'NEEDS WORK' : 'PRODUCTION READY',
      target: { type: 'repo', path: '.' },
      project: { type: 'express', frameworks: [], languages: [], totalLines: 0 },
      categories: [],
      summary: {
        totalFindings: blockers,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        byImpact: { blocker: blockers, degradation: 0, cosmetic: 0 },
        blockers,
        fixable: 0,
        estimatedMinutesToLaunch: 0,
        estimatedTimeToLaunch: 'n/a',
      },
      topBlockers: [],
      findings: [],
      durationMs: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  const baseOptions = {
    path: '.',
    format: 'summary' as const,
    compare: false,
    baseline: false,
    failOn: 'blocker' as const,
    disable: [],
    enable: [],
    include: [],
    exclude: [],
    annotations: false,
    verbose: false,
    full: false,
    cwd: '.',
    quiet: true,
  };

  it('passes above the threshold with no blockers', () => {
    expect(exitCodeFor(report(90, 0), DEFAULT_CONFIG, baseOptions)).toBe(0);
  });

  it('fails below the threshold', () => {
    expect(exitCodeFor(report(30, 0), DEFAULT_CONFIG, baseOptions)).toBe(1);
  });

  it('fails on any blocker', () => {
    // The check reads the findings, not the summary, so a report claiming a
    // blocker with no matching finding is not a blocker.
    expect(exitCodeFor(report(95, 0), DEFAULT_CONFIG, baseOptions)).toBe(0);
    const withBlocker = report(95, 0);
    withBlocker.findings = [{ ...blockerStub(), productionImpact: 'blocker' }] as never;
    expect(exitCodeFor(withBlocker, DEFAULT_CONFIG, baseOptions)).toBe(1);
  });

  it('never fails with --fail-on never', () => {
    expect(exitCodeFor(report(1, 99), DEFAULT_CONFIG, { ...baseOptions, failOn: 'never' })).toBe(0);
  });

  it('honours a custom threshold', () => {
    expect(exitCodeFor(report(60, 0), DEFAULT_CONFIG, { ...baseOptions, threshold: 55 })).toBe(0);
    expect(exitCodeFor(report(60, 0), DEFAULT_CONFIG, { ...baseOptions, threshold: 80 })).toBe(1);
  });

  it('baseline mode only fails on a regression', () => {
    const options = { ...baseOptions, baseline: true };

    const improved = report(85, 0);
    improved.comparison = comparison({ previousScore: 80, scoreDelta: 5, regressions: [] });
    expect(exitCodeFor(improved, DEFAULT_CONFIG, options)).toBe(0);

    const regressed = report(70, 1);
    regressed.comparison = comparison({
      previousScore: 80,
      scoreDelta: -10,
      regressions: [blockerStub()],
    });
    expect(exitCodeFor(regressed, DEFAULT_CONFIG, options)).toBe(1);

    // A new blocker at an unchanged score is still a regression.
    const newBlocker = report(80, 2);
    newBlocker.comparison = comparison({ previousScore: 80, scoreDelta: 0, regressions: [blockerStub()] });
    expect(exitCodeFor(newBlocker, DEFAULT_CONFIG, options)).toBe(1);
  });

  it('baseline mode passes on the first run', () => {
    expect(exitCodeFor(report(10, 50), DEFAULT_CONFIG, { ...baseOptions, baseline: true })).toBe(0);
  });
});