import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

/**
 * First-run scaffolding: `shipready init`.
 *
 * Scope is deliberately conservative. We generate a CI workflow and a
 * `.shipready.yml` config file, and we add a small script to `package.json`.
 * We never overwrite an existing pipeline: if the repository already has a CI
 * workflow, we say so and explain how to add the step, because silently
 * replacing someone's release pipeline is not a feature.
 */

export interface InitOptions {
  ci: boolean;
  force: boolean;
  threshold: number;
  cwd: string;
}

export interface InitResult {
  created: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  nextSteps: string[];
}

const CI_TARGETS: { file: string; label: string }[] = [
  { file: '.github/workflows/ci.yml', label: 'GitHub Actions' },
  { file: '.gitlab-ci.yml', label: 'GitLab CI' },
  { file: '.circleci/config.yml', label: 'CircleCI' },
  { file: 'Jenkinsfile', label: 'Jenkins' },
];

/**
 * The version this CLI was installed as.
 *
 * Written into the generated workflow so the gate is reproducible. A bare
 * `npx shipready` resolves to whatever is newest at the moment CI runs, so a
 * patch release could change a build's outcome with no commit to show for it,
 * and before the first publish it fails outright. Falls back to reading the
 * package's own manifest, which is what actually gets printed.
 */
function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * The snippet shown when a pipeline already exists, so the user is told what to
 * add rather than having a second file written for them.
 *
 * A function rather than a constant because the values are interpolated
 * directly. This was a constant with `$THRESHOLD`-style placeholders that were
 * then substituted by `.replace('${THRESHOLD}', ...)`, which never matched --
 * the escaped form is `$THRESHOLD`, not `${THRESHOLD}`. Anyone who had a CI
 * file already and ran `shipready init --ci` was shown a literal
 * `$THRESHOLD` to paste, and `npx shipready` that would not exist before the
 * first publish.
 */
function pipelineSnippet(threshold: number): string {
  return `# ShipReady: production readiness gate.
# Fails the build when the score drops below ${threshold}, or when a
# launch-blocker appears that was not there before.
npx shipready@${cliVersion()} scan . --threshold ${threshold} --format sarif --output shipready.sarif

# Optional: upload SARIF to GitHub code scanning.
# - uses: github/codeql-action/upload-sarif@v3
#   with:
#     sarif_file: shipready.sarif`;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const cwd = resolve(options.cwd);
  const created: InitResult['created'] = [];
  const skipped: InitResult['skipped'] = [];
  const nextSteps: string[] = [];

  if (options.ci) {
    const existing = await findExistingPipeline(cwd);
    if (existing && !options.force) {
      skipped.push({
        path: existing.file,
        reason: `${existing.label} already configured. Add the readiness step yourself:
${indent(pipelineSnippet(options.threshold))}`,
      });
    } else {
      const path = existing?.file ?? CI_TARGETS[0]!.file;
      const abs = resolve(cwd, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, renderPipeline(options.threshold), 'utf8');
      created.push({ path, reason: `${existing?.label ?? 'GitHub Actions'} workflow with a readiness gate` });
      if (!existing) {
        skipped.push({
          path: '.gitlab-ci.yml',
          reason: 'Only one pipeline was written. Re-run with --ci to write a different one.',
        });
      }
    }
  }

  const configPath = '.shipready.yml';
  await writeIfAbsent(cwd, configPath, renderConfig(options.threshold), created, skipped, 'ShipReady configuration');

  const packageJsonPath = resolve(cwd, 'package.json');
  if (await exists(packageJsonPath)) {
    const added = await addScripts(packageJsonPath, options.threshold);
    if (added) created.push({ path: 'package.json', reason: 'added "readiness" and "readiness:ci" scripts' });
    else skipped.push({ path: 'package.json', reason: 'readiness scripts already present' });
  }

  const gitignorePath = resolve(cwd, '.gitignore');
  await ensureIgnoreEntry(gitignorePath, ['.shipready/', 'shipready.sarif']);

  nextSteps.push('Run `shipready scan .` to see where you stand.');
  if (options.ci) nextSteps.push('Push to a branch and open a pull request to see the readiness gate.');
  nextSteps.push('Run `shipready observe -- <your agent command>` to capture your first trace.');
  nextSteps.push('Run `shipready comply init` to start your compliance documentation.');

  return { created, skipped, nextSteps };
}

async function findExistingPipeline(cwd: string): Promise<{ file: string; label: string } | null> {
  const { access } = await import('node:fs/promises');
  const present = async (path: string): Promise<boolean> => {
    try {
      await access(resolve(cwd, path));
      return true;
    } catch {
      return false;
    }
  };
  for (const target of CI_TARGETS) {
    if (await present(target.file)) return target;
  }
  if (await present('.drone.yml')) return { file: '.drone.yml', label: 'Drone' };
  return null;
}

async function writeIfAbsent(
  cwd: string,
  path: string,
  content: string,
  created: InitResult['created'],
  skipped: InitResult['skipped'],
  reason: string,
): Promise<void> {
  const abs = resolve(cwd, path);
  if (await exists(abs)) {
    skipped.push({ path, reason: 'already exists, left untouched' });
    return;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  created.push({ path, reason });
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises');
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function addScripts(packageJsonPath: string, threshold: number): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  const scripts = (parsed.scripts ?? {}) as Record<string, string>;
  if (scripts.readiness) return false;
  parsed.scripts = {
    ...scripts,
    readiness: 'shipready scan .',
    'readiness:ci': `shipready scan . --threshold ${threshold} --format sarif --output shipready.sarif`,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return true;
}

async function ensureIgnoreEntry(gitignorePath: string, entries: readonly string[]): Promise<void> {
  let current = '';
  if (await exists(gitignorePath)) {
    current = await readFile(gitignorePath, 'utf8');
  }
  const lines = current.split(/\r?\n/);
  const additions = entries.filter((entry) => !lines.includes(entry));
  if (additions.length === 0) return;
  const prefix = current.length === 0 ? '' : current.endsWith('\n') ? current : `${current}\n`;
  await writeFile(gitignorePath, `${prefix}\n# ShipReady\n${additions.join('\n')}\n`, 'utf8');
}

function renderPipeline(threshold: number): string {
  const version = cliVersion();
  return `name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Lint, typecheck, test, production readiness
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npm run lint --if-present
      - run: npx tsc --noEmit --if-present
      - run: npm test --if-present

      # ShipReady: production readiness gate.
      # Fails below ${threshold}, and fails outright on any new launch blocker.
      - name: Production readiness
        run: npx shipready@${version} scan . --threshold ${threshold} --format sarif --output shipready.sarif

      # Upload to GitHub code scanning so findings show up on the PR diff.
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: shipready.sarif
          category: shipready-production-readiness

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: production-readiness
          path: shipready.sarif
`;
}

function renderConfig(threshold: number): string {
  return `# ShipReady configuration.
# https://shipready.ai/docs/configuration

version: 1

scan:
  # Fail CI below this score.
  threshold: ${threshold}
  # Ignore a rule:
  # disable:
  #   - readiness/performance/no-lazy-loading
  # Raise or lower the noise floor (0-1):
  minConfidence: 0.3
  # Skip files:
  # exclude:
  #   - '**/fixtures/**'

fix:
  # How many fixes to generate in one pass.
  limit: 10

observe:
  # Alert when a session crosses this fraction of its budget.
  costBudget: 10.00
  # Warn when a single trace spends more than this.
  costPerTrace: 2.00

compliance:
  # Primary jurisdiction. Drives which frameworks are generated.
  jurisdiction: EU
  frameworks:
    - eu-ai-act
    - gdpr
`;
}

function indent(text: string, spaces = 4): string {
  return text
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n');
}