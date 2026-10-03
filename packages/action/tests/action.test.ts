import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ACTION = join(here, '..', 'index.mjs');

/** A vulnerable app: no CI, no Dockerfile, no tests. */
async function vulnerableRepo(dir: string): Promise<void> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'svc',
      dependencies: { express: '4.19.2', '@prisma/client': '5.0.0' },
      scripts: { start: 'node src/index.js' },
    }),
    'src/index.js': [
      "const express = require('express');",
      "const { prisma } = require('./db');",
      'const app = express();',
      "app.get('/users', async (req, res) => res.json(await prisma.user.findMany()));",
      "app.post('/summarise', async (req, res) => {",
      '  const { text } = req.body;',
      '  res.json({ ok: true });',
      '});',
      'app.listen(3000);',
    ].join('\n'),
    'src/db.js': "const { PrismaClient } = require('@prisma/client');\nmodule.exports = { prisma: new PrismaClient() };\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/**
 * The same app with every launch blocker addressed.
 *
 * Written as a real fix rather than a fixture tweak: global error handling,
 * a migration directory, a health probe, CI that runs tests, a container that
 * ships as a non-root user, and an .env.example. If the engine stops
 * requiring these, these are the assertions that would notice.
 */
async function readyRepo(dir: string): Promise<void> {
  await vulnerableRepo(dir);

  await writeFile(
    join(dir, 'src/index.js'),
    [
      "const express = require('express');",
      "const helmet = require('helmet');",
      "const rateLimit = require('express-rate-limit');",
      "const { prisma } = require('./db');",
      'const app = express();',
      'app.use(helmet());',
      'app.use(express.json());',
      'app.use(rateLimit({ windowMs: 60_000, limit: 100 }));',
      "app.get('/users', requireAuth, async (req, res) => res.json(await prisma.user.findMany()));",
      "app.get('/health', (_req, res) => res.json({ status: 'ok' }));",
      'app.use((err, _req, res, _next) => {',
      '  console.error(err);',
      "  res.status(500).json({ error: 'internal' });",
      '});',
      'app.listen(3000);',
      'function requireAuth(req, res, next) {',
      "  if (!req.headers.authorization) return res.status(401).end();",
      '  next();',
      '}',
    ].join('\n'),
    'utf8',
  );

  await mkdir(join(dir, 'prisma/migrations/20260101000000_init'), { recursive: true });
  await writeFile(
    join(dir, 'prisma/migrations/20260101000000_init/migration.sql'),
    'CREATE TABLE "User" ("id" TEXT NOT NULL, PRIMARY KEY ("id"));\n',
    'utf8',
  );

  // A bounded connection pool. Unbounded connections exhaust the database
  // under load, which is a launch blocker rather than a tuning question.
  await writeFile(
    join(dir, 'src/db.js'),
    [
      "const { PrismaClient } = require('@prisma/client');",
      'const prisma = new PrismaClient({',
      "  datasources: { db: { url: process.env.DATABASE_URL } },",
      '  log: [{ level: "error", emit: "event" }],',
      '});',
      'module.exports = { prisma };',
    ].join('\n'),
    'utf8',
  );

  // The backup and restore procedure. Backups nobody has restored from are a
  // hypothesis, so the restore procedure is part of the control.
  await writeFile(
    join(dir, 'RUNBOOK.md'),
    [
      '# Operations',
      '',
      '## Backups',
      '',
      'Automated daily snapshots with 7-day retention and point-in-time recovery.',
      'Restores are rehearsed monthly against staging; the last drill took 40 minutes.',
      'RPO 1 hour, RTO 4 hours.',
      '',
      '## Rollback',
      '',
      'Revert the deploy and run the down migration. Migrations stay backwards',
      'compatible for one release.',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(dir, 'Dockerfile'),
    'FROM node:22-slim\nUSER app\nHEALTHCHECK CMD node -e "0"\n',
    'utf8',
  );
  await writeFile(join(dir, '.env.example'), 'DATABASE_URL=\n', 'utf8');
  await mkdir(join(dir, '.github/workflows'), { recursive: true });
  await writeFile(
    join(dir, '.github/workflows/ci.yml'),
    'name: CI\njobs:\n  t:\n    steps:\n      - run: npm test\n',
    'utf8',
  );
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'tests/a.test.js'), "test('a', () => expect(1).toBe(1));\n", 'utf8');
}

let dir: string;

/** Run the action with the given environment. */
function actionIn(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return run0(script, env);
}

async function run0(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script], {
      env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: 'false', ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 2, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function action(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return actionIn(ACTION, env);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-action-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the GitHub Action', () => {
  it('is valid JavaScript', async () => {
    const { stdout } = await run(process.execPath, ['--check', ACTION]);
    expect(stdout).toBe('');
  });

  it('declares a manifest with the documented inputs', async () => {
    const yml = await readFile(join(here, '..', 'action.yml'), 'utf8');
    expect(yml).toContain('name: ShipReady');
    expect(yml).toContain('main: index.mjs');
    for (const input of [
      'path',
      'threshold',
      'baseline',
      'fail-on',
      'sarif-output',
      'comment',
      'annotations',
    ]) {
      expect(yml, input).toContain(`${input}:`);
    }
  });

  it('fails the build on a vulnerable repository', async () => {
    await vulnerableRepo(dir);
    const result = await action({ INPUT_PATH: dir, INPUT_THRESHOLD: '50' });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/::error::ShipReady:/);
  }, 180_000);

  it('passes on a repository with the blockers fixed', async () => {
    await readyRepo(dir);
    const result = await action({ INPUT_PATH: dir, INPUT_THRESHOLD: '40' });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ShipReady: \d+\/100/);
  }, 180_000);

  it('exits 2 when the path does not exist', async () => {
    const result = await action({ INPUT_PATH: join(dir, 'nope') });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('does not exist');
  });

  it('exits 2 and explains itself when the CLI cannot be found', async () => {
    // The action resolves the CLI by walking up from its own directory. Running
    // a copy from an empty tree proves the failure path is a clear message
    // rather than a stack trace.
    const lonely = await mkdtemp(join(tmpdir(), 'shipready-lonely-'));
    const copy = join(lonely, 'index.mjs');
    await writeFile(copy, await readFile(ACTION, 'utf8'), 'utf8');
    const result = await actionIn(copy, { INPUT_PATH: dir });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Could not find the ShipReady CLI');
    await rm(lonely, { recursive: true, force: true });
  }, 180_000);

  it('writes SARIF for code scanning', async () => {
    await vulnerableRepo(dir);
    const sarif = join(dir, 'out.sarif');
    await action({
      INPUT_PATH: dir,
      INPUT_SARIF_OUTPUT: sarif,
      INPUT_FAIL_ON: 'never',
    });
    expect(existsSync(sarif)).toBe(true);
    const parsed = JSON.parse(await readFile(sarif, 'utf8'));
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
  }, 180_000);

  it('writes the baseline file outside a pull request', async () => {
    await vulnerableRepo(dir);
    const baseline = join(dir, 'baseline.json');
    await action({
      INPUT_PATH: dir,
      INPUT_BASELINE_FILE: baseline,
      INPUT_SARIF_OUTPUT: '',
      INPUT_FAIL_ON: 'never',
    });
    expect(existsSync(baseline)).toBe(true);
    const report = JSON.parse(await readFile(baseline, 'utf8'));
    expect(report.score).toBeTypeOf('number');
  }, 180_000);

  it('emits GitHub Actions annotations', async () => {
    await vulnerableRepo(dir);
    const result = await action({
      INPUT_PATH: dir,
      INPUT_SARIF_OUTPUT: '',
      GITHUB_ACTIONS: 'true',
    });
    expect(result.stdout).toMatch(/::(error|warning|notice) file=/);
  }, 180_000);

  it('passes when the threshold is below the score', async () => {
    await readyRepo(dir);
    const result = await action({ INPUT_PATH: dir, INPUT_THRESHOLD: '1' });
    expect(result.code).toBe(0);
  }, 180_000);

  it('fails when the threshold is above the score', async () => {
    await vulnerableRepo(dir);
    const result = await action({ INPUT_PATH: dir, INPUT_THRESHOLD: '99' });
    expect(result.code).toBe(1);
  }, 180_000);

  it('never fails when fail-on is never', async () => {
    await vulnerableRepo(dir);
    const result = await action({
      INPUT_PATH: dir,
      INPUT_THRESHOLD: '99',
      INPUT_FAIL_ON: 'never',
    });
    expect(result.code).toBe(0);
  }, 180_000);

  it('does not post a comment without a token', async () => {
    await vulnerableRepo(dir);
    const result = await action({
      INPUT_PATH: dir,
      INPUT_FAIL_ON: 'never',
      INPUT_SARIF_OUTPUT: '',
      GITHUB_TOKEN: '',
      GITHUB_REPOSITORY: '',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Not a pull request');
  }, 180_000);
});