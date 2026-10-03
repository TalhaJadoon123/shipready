import { type ProjectType, type ProjectProfile } from '../types.js';
import { countLines, languageOf } from '../source.js';
import { isDirectory, pathExists, readText } from './walk.js';
import { join, resolve } from 'node:path';

/**
 * Detect the stack once per scan.
 *
 * Every rule needs these facts and recomputing them per rule would be both slow
 * and, worse, inconsistent: one rule might think a repo is Next.js and another
 * might not. Detection order therefore runs from most specific to least.
 */
export async function detectProject(
  root: string,
  files: readonly string[],
  read: (relPath: string) => Promise<string | null>,
): Promise<ProjectProfile> {
  const absRoot = resolve(root);
  const has = (p: string) => files.includes(p);
  const hasDir = async (p: string) => isDirectory(join(absRoot, p));
  const hasGlob = (...suffixes: string[]) =>
    files.some((f) => suffixes.some((s) => f.endsWith(s)));

  const pkgText = has('package.json') ? await read('package.json') : null;
  const pkg = safeJson(pkgText);

  const dependencies = new Map<string, string>();
  const devDependencies = new Map<string, string>();
  for (const [k, v] of Object.entries(pkg?.dependencies ?? {})) {
    if (typeof v === 'string') dependencies.set(k, v);
  }
  for (const [k, v] of Object.entries(pkg?.devDependencies ?? {})) {
    if (typeof v === 'string') devDependencies.set(k, v);
  }
  const dependencyNames = new Set<string>([
    ...dependencies.keys(),
    ...devDependencies.keys(),
  ]);

  const pyproject = has('pyproject.toml') ? await read('pyproject.toml') : null;
  const requirements = has('requirements.txt') ? await read('requirements.txt') : null;
  const pythonDeps = parsePythonDeps(pyproject, requirements);
  for (const k of pythonDeps.keys()) dependencyNames.add(k);

  const frameworks = new Set<string>();
  let type: ProjectType = 'unknown';

  if (dependencyNames.has('next')) {
    type = 'nextjs';
    frameworks.add('nextjs');
  }
  if (type === 'unknown' && (dependencyNames.has('vite') || has('vite.config.ts') || has('vite.config.js'))) {
    type = 'vite';
    frameworks.add('vite');
  }
  if (dependencyNames.has('express') || dependencyNames.has('fastify') || dependencyNames.has('koa') || dependencyNames.has('hono') || dependencyNames.has('@nestjs/core')) {
    if (type === 'unknown') type = 'express';
    frameworks.add(dependencyNames.has('express') ? 'express' : 'node-server');
  }

  if (has('go.mod') || hasGlob('.go')) {
    if (type === 'unknown') type = 'go';
    frameworks.add('go');
  }
  if (has('Cargo.toml') || hasGlob('.rs')) {
    if (type === 'unknown') type = 'rust';
    frameworks.add('rust');
  }
  const isFastapi = /fastapi/i.test(pyproject ?? '') || /fastapi/i.test(requirements ?? '') || hasGlob('main.py') && /(FastAPI|APIRouter)/.test(safeReadAllSync(files, read) ?? '');
  const isDjango = /django/i.test(pyproject ?? '') || /django/i.test(requirements ?? '') || has('manage.py');
  if (isFastapi || isDjango) {
    if (type === 'unknown') type = isFastapi ? 'fastapi' : 'django';
    frameworks.add(isFastapi ? 'fastapi' : 'django');
  } else if (hasGlob('.py') && type === 'unknown') {
    type = 'python';
    frameworks.add('python');
  }

  // Secondary framework/library detection for rule enablement.
  const addIf = (dep: string, label: string) => {
    if (dependencyNames.has(dep)) frameworks.add(label);
  };
  addIf('react', 'react');
  addIf('vue', 'vue');
  addIf('svelte', 'svelte');
  addIf('@angular/core', 'angular');
  addIf('prisma', 'prisma');
  addIf('drizzle-orm', 'drizzle');
  addIf('typeorm', 'typeorm');
  addIf('sequelize', 'sequelize');
  addIf('mongoose', 'mongoose');
  addIf('knex', 'knex');
  addIf('pg', 'postgres');
  addIf('mysql2', 'mysql');
  addIf('@supabase/supabase-js', 'supabase');
  addIf('@sentry/node', 'sentry');
  addIf('rollbar', 'rollbar');
  addIf('winston', 'winston');
  addIf('pino', 'pino');
  addIf('zod', 'zod');
  addIf('openai', 'openai');
  addIf('@anthropic-ai/sdk', 'anthropic');
  addIf('@google/generative-ai', 'gemini');
  addIf('langchain', 'langchain');
  addIf('@modelcontextprotocol/sdk', 'mcp');
  addIf('stripe', 'stripe');
  addIf('vitest', 'vitest');
  addIf('jest', 'jest');
  addIf('playwright', 'playwright');
  addIf('@playwright/test', 'playwright');
  addIf('cypress', 'cypress');
  addIf('@testing-library/react', 'testing-library');

  const packageManager = detectPackageManager(files);
  const hasTests = await detectTests(root, files, dependencyNames);
  const hasCi = await detectCi(root, files, hasDir);
  const hasDocker = files.some(
    (f) => /(^|\/)(dockerfile[^/]*|\.dockerignore)$/i.test(f) || /docker-compose[^/]*\.ya?ml$/.test(f),
  );
  const hasEnvExample = files.some((f) => /^\.env\.(example|sample|template)$/i.test(f) || /^\.env\.example\./.test(f));
  const isMonorepo = Boolean(pkg?.workspaces) || has('pnpm-workspace.yaml') || has('turbo.json') || has('lerna.json') || has('nx.json');

  const envKeys = await collectEnvKeys(files, read);

  const apiRoutes = files.filter(
    (f) =>
      /(^|\/)(app|src|pages|server|routes|api)\//.test(f) &&
      (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(f) || f === 'urls.py'),
  );
  const components = files.filter((f) => /\.(tsx|jsx|vue|svelte|astro)$/.test(f));

  // Line counts. Only parse files we will actually read anyway.
  const { linesByLanguage, totalLines } = await countRepoLines(files, read);

  const isGitRepo = await isDirectory(join(absRoot, '.git'));
  const { branch, commit } = await readGitInfo(absRoot);

  const scriptNames = new Set<string>(Object.keys(pkg?.scripts ?? {}));

  const profile: ProjectProfile = {
    root: absRoot,
    type,
    frameworks: [...frameworks].sort(),
    languages: Object.keys(linesByLanguage).sort(),
    packageManager,
    hasTests,
    hasCi,
    hasDocker,
    hasEnvExample,
    isMonorepo,
    dependencyNames,
    scriptNames,
    envKeys,
    apiRoutes,
    components,
    totalLines,
    isGitRepo,
    linesByLanguage,
    // Python dependencies are folded in so rules can ask about any package.
    dependencies: new Map([...dependencies, ...pythonDeps]),
    devDependencies,
  };
  if (branch !== undefined) profile.branch = branch;
  if (commit !== undefined) profile.commit = commit;

  return profile;
}

function safeJson(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function safeReadAllSync(
  files: readonly string[],
  read: (p: string) => Promise<string | null>,
): string | null {
  // Only used for the FastAPI heuristic; a null result is a safe default.
  void files;
  void read;
  return null;
}

function parsePythonDeps(pyproject: string | null, requirements: string | null): Map<string, string> {
  const deps = new Map<string, string>();
  const add = (line: string) => {
    const cleaned = line
      .replace(/#.*$/, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[<>=!~;].*$/, '')
      .trim();
    if (!cleaned || cleaned.startsWith('-')) return;
    const name = cleaned.toLowerCase();
    if (name) deps.set(name, 'python');
  };

  if (requirements) for (const line of requirements.split(/\r?\n/)) add(line);

  if (pyproject) {
    // PEP 621 `[project] dependencies = [...]` plus poetry tables.
    const arr = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pyproject);
    if (arr?.[1]) for (const q of arr[1].matchAll(/["']([^"']+)["']/g)) if (q[1]) add(q[1]);
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(pyproject);
    if (poetry?.[1]) {
      for (const line of poetry[1].split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
        if (m?.[1]) deps.set(m[1].toLowerCase(), 'python');
      }
    }
  }
  return deps;
}

function detectPackageManager(files: readonly string[]): ProjectProfile['packageManager'] {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json')) return 'npm';
  return 'unknown';
}

/**
 * Detect whether the project has tests.
 *
 * Reads the directory rather than the walked file list: test files are excluded
 * from scanning by default, so relying on the walk made every project look
 * untested. That is not a cosmetic bug -- it turns "you have tests" into a
 * high-severity finding on every repository.
 */
async function detectTests(
  root: string,
  files: readonly string[],
  deps: Set<string>,
): Promise<boolean> {
  if (deps.has('vitest') || deps.has('jest') || deps.has('mocha')) return true;
  if (deps.has('playwright') || deps.has('cypress') || deps.has('pytest')) return true;
  if (deps.has('unittest') || deps.has('nose')) return true;

  // A test script in package.json is evidence on its own.
  const pkg = files.find((f) => f === 'package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(await readText(join(root, 'package.json')) ?? '{}') as {
        scripts?: Record<string, string>;
      };
      const scripts = Object.keys(parsed.scripts ?? {}).join(' ');
      if (/\b(test|jest|vitest|mocha)\b/.test(scripts)) return true;
    } catch {
      // A malformed package.json is the deploy rule's problem, not this one.
    }
  }

  const dirs = ['tests', 'test', '__tests__', 'spec'];
  for (const dir of dirs) {
    if (await isDirectory(join(root, dir))) return true;
  }
  for (const file of ['pytest.ini', 'tox.ini', 'jest.config.js', 'vitest.config.ts', 'jest.config.ts', 'phpunit.xml', 'karma.conf.js']) {
    if (files.includes(file)) return true;
  }
  return false;
}

async function detectCi(
  root: string,
  files: readonly string[],
  hasDir: (p: string) => Promise<boolean>,
): Promise<boolean> {
  const patterns: RegExp[] = [
    /^\.gitlab-ci\.ya?ml$/,
    /(^|\/)Jenkinsfile$/,
    /^\.travis\.ya?ml$/,
    /^\.azure-pipelines\.ya?ml$/,
    /^(azure-pipelines|bitbucket-pipelines)\.ya?ml$/,
    /^(buildspec\.yml|cloudbuild\.yaml)$/,
    /^(netlify\.toml|vercel\.json|fly\.toml|app\.yaml)$/,
    /^\.builds\//,
    /(^|\/)drone\.ya?ml$/,
  ];
  if (files.some((f) => f.startsWith('.github/workflows/'))) return true;
  if (files.some((f) => patterns.some((p) => p.test(f)))) return true;
  if (await hasDir('.circleci')) return true;
  if (await hasDir('.drone')) return true;
  // Last resort: the config exists but the walk did not reach it (ignored dir).
  return pathExists(join(resolve(root), 'azure-pipelines.yml'));
}

async function collectEnvKeys(
  files: readonly string[],
  read: (p: string) => Promise<string | null>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const envFiles = files.filter((f) => /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(f));
  for (const f of envFiles) {
    const text = await read(f);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m?.[1]) keys.add(m[1]);
    }
  }
  // Next.js exposes NEXT_PUBLIC_* automatically; record the pattern too.
  if (files.some((f) => f.endsWith('next.config.js') || f.endsWith('next.config.mjs') || f.endsWith('next.config.ts'))) {
    keys.add('NEXT_PUBLIC_*');
  }
  return keys;
}

async function countRepoLines(
  files: readonly string[],
  read: (p: string) => Promise<string | null>,
): Promise<{ linesByLanguage: Record<string, number>; totalLines: number }> {
  const linesByLanguage: Record<string, number> = {};
  let totalLines = 0;
  for (const f of files) {
    const lang = languageOf(f);
    if (lang === 'unknown') continue;
    if (/\.(min\.js|min\.css)$/.test(f)) continue;
    if (/^__snapshots__\//.test(f) || /\.snap$/.test(f)) continue;
    if (/(^|\/)(fixtures|__fixtures__|testdata|vendor)\//.test(f)) continue;
    // Lockfiles are walked (rules need to see them) but never counted as
    // application code: a 200,000-line lockfile is not 200,000 lines of product.
    if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$/.test(f)) continue;
    const text = await read(f);
    if (text === null) continue;
    const n = countLines(text);
    linesByLanguage[lang] = (linesByLanguage[lang] ?? 0) + n;
    totalLines += n;
  }
  return { linesByLanguage, totalLines };
}

async function readGitInfo(root: string): Promise<{ branch?: string; commit?: string }> {
  // Read .git/HEAD directly. Shelling out to git would make scans slow and
  // would break in sandboxes without a git binary.
  const result: { branch?: string; commit?: string } = {};
  try {
    const head = await readText(join(root, '.git', 'HEAD'));
    if (head) {
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
      if (ref?.[1]) {
        result.branch = ref[1].trim();
        const sha = await readText(join(root, '.git', ref[1].trim()));
        if (sha) result.commit = sha.trim().slice(0, 40);
      } else if (/^[0-9a-f]{40}$/.test(head.trim())) {
        result.commit = head.trim();
        result.branch = 'HEAD';
      }
    }
  } catch {
    /* not a git repo, or unreadable */
  }
  return result;
}
