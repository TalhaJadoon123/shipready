import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build must survive `pnpm clean`.
 *
 * `tsc --incremental` records which outputs it believes are current in a
 * buildinfo file. If `dist/` is deleted but that file survives, `tsc` concludes
 * there is nothing to do, emits nothing, and exits 0 -- so the build looks
 * green while every package is empty. That is not hypothetical: `pnpm clean` was
 * a rimraf glob, which rimraf 6 treats as a literal path and fails with
 * `Illegal characters in path`, so the orphaned buildinfo files outlived
 * every "clean" and a `pnpm clean && pnpm -r build` then failed with
 * `Cannot find module '@shipready/observer'` while turbo reported that package
 * as building successfully.
 *
 * These assertions are cheap and static: they check the configuration that would
 * cause the failure, so they do not need to run a build.
 */
/**
 * The repository root.
 *
 * `tests/` -> `packages/core/` -> `packages/` -> the repo. Three levels, not
 * two: one of these tests asserts against sibling packages and the root
 * package.json, so resolving from the package directory would find neither.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** Packages compiled by `tsc` into `dist/`. */
const COMPILED = ['core', 'cli', 'observer', 'compliance', 'einvoice'];

/** Packages that legitimately have no `dist/`, and why. */
const NO_DIST: Record<string, string> = {
  // Rule packs are data; its build step is a no-op by design.
  rules: 'ships rule packs as data, build is a no-op',
  // Next.js writes `.next/`, not `dist/`.
  web: 'Next.js output goes to .next/',
  // A GitHub Action is an entrypoint plus a manifest; nothing to compile.
  action: 'no compile step',
};

/**
 * Parse a tsconfig, which is JSONC.
 *
 * These files carry `//` comments explaining *why* tsBuildInfoFile sits inside
 * dist. `JSON.parse` rejects those, so strip comments and trailing commas first.
 * A regex is the wrong tool in general; this is fine because we control every
 * file being read and none of them contain `//` inside a string literal.
 */
function readTsConfig(path: string): {
  compilerOptions?: { outDir?: string; tsBuildInfoFile?: string };
} {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

describe('build configuration', () => {
  it('puts tsBuildInfoFile inside dist for every compiled package', () => {
    for (const pkg of COMPILED) {
      const config = join(repoRoot, 'packages', pkg, 'tsconfig.build.json');
      expect(existsSync(config), `${pkg} has no tsconfig.build.json`).toBe(true);

      const parsed = readTsConfig(config);

      expect(parsed.compilerOptions?.outDir, `${pkg} has no outDir`).toBe('dist');

      const info = parsed.compilerOptions?.tsBuildInfoFile;
      expect(info, `${pkg} does not set tsBuildInfoFile, so incremental build state can outlive dist/`).toBeDefined();
      expect(
        info!.startsWith('dist/'),
        `${pkg} tsBuildInfoFile is "${info}", which is outside dist/. A clean that deletes dist/ but keeps the buildinfo produces a silent no-op build.`,
      ).toBe(true);
    }
  });

  it('uses a clean script that does not pass globs to rimraf', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const clean = pkg.scripts?.clean ?? '';

    // rimraf 6 treats every argument as a literal path and fails on a glob.
    expect(clean).not.toContain('rimraf');
    expect(clean).toContain('scripts/clean.mjs');
  });

  it('removes both dist and any stray buildinfo when cleaning', () => {
    const source = readFileSync(join(repoRoot, 'scripts', 'clean.mjs'), 'utf8');
    expect(source).toContain('dist');
    expect(source).toContain('.tsbuildinfo');
  });

  it('ships a clean-build verifier', () => {
    // The guard that catches this class of failure in CI.
    expect(existsSync(join(repoRoot, 'scripts', 'verify-build.mjs'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['verify:build']).toContain('verify-build.mjs');
  });

  it('caps the worker pool of the heaviest test suites', () => {
    // Seven vitest suites running their own pools at turbo's default
    // concurrency produced `[vitest-worker]: Timeout calling "onTaskUpdate"` in
    // @shipready/observer and @shipready/action. That reads like a test failure
    // and is not one: every suite passes on its own.
    //
    // The fix is per-package fork limits rather than a turbo-level
    // `concurrency`, because turbo's is a root-only option -- setting it inside
    // `tasks.test` is rejected with "Found an unknown key `concurrency`" -- and
    // a root value of 1 would also serialise `pnpm build`.
    //
    // observer opens a real SQLite database per test and spawns child agents;
    // action shells out to the CLI, so each test is its own process tree.
    // @shipready/action is deliberately absent: capping it made 7 of 13 tests
    // fail, because those tests share temp directories and need the
    // parallelism. @shipready/observer is capped instead, and that is where the
    // timeouts actually appeared.
    for (const pkg of ['observer', 'core', 'cli']) {
      const config = join(repoRoot, 'packages', pkg, 'vitest.config.ts');
      expect(existsSync(config), `${pkg} has no vitest.config.ts`).toBe(true);
      const raw = readFileSync(config, 'utf8');

      // Either an explicit pool size or a single fork, but not the default.
      const hasLimit =
        /singleFork:\s*true/.test(raw) ||
        /maxForks:\s*\d+/.test(raw) ||
        /maxThreads:\s*\d+/.test(raw) ||
        /minWorkers:\s*\d+/.test(raw);
      expect(hasLimit, `${pkg} vitest.config.ts sets no worker-pool limit`).toBe(true);
    }

    // The one that must be strictest, and strictest in a way that keeps
    // isolation: a single fork, not merely a small pool.
    const observer = readFileSync(join(repoRoot, 'packages', 'observer', 'vitest.config.ts'), 'utf8');
    expect(observer).toMatch(/singleFork:\s*true/);
  });

  it('keeps turbo.json free of keys turbo rejects', () => {
    // turbo.json is strict JSON with a closed key set: no comments, and
    // `concurrency` is root-only. Both mistakes fail with
    // `turbo_json_parse_error`, which reads as a build failure with no hint
    // about the cause.
    const raw = readFileSync(join(repoRoot, 'turbo.json'), 'utf8');
    expect(() => JSON.parse(raw), 'turbo.json is not valid JSON').not.toThrow();

    const turbo = JSON.parse(raw) as { tasks?: Record<string, Record<string, unknown>> };
    for (const [task, config] of Object.entries(turbo.tasks ?? {})) {
      expect(
        config['//'],
        `tasks.${task} has a "//" comment key, which turbo rejects with turbo_json_parse_error`,
      ).toBeUndefined();
      expect(
        config['concurrency'],
        `tasks.${task} sets concurrency, which is a root-only option and is rejected inside a task`,
      ).toBeUndefined();
    }
  });

  it('documents which packages are expected to have no dist', () => {
    // If a new package is added, it must be classified here rather than
    // silently passing because `dist/` happens to be absent.
    for (const name of Object.keys(NO_DIST)) {
      expect(
        existsSync(join(repoRoot, 'packages', name)),
        `NO_DIST lists ${name}, which no longer exists`,
      ).toBe(true);
    }

    const packagesDir = join(repoRoot, 'packages');
    const actual = readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory());
    for (const name of actual) {
      const classified = COMPILED.includes(name) || name in NO_DIST;
      expect(classified, `package ${name} is neither in COMPILED nor NO_DIST; classify it`).toBe(true);
    }
  });
});

describe('published packages', () => {
  /** Packages intended to reach npm, in publish order. */
  const PUBLISHABLE = ['core', 'rules', 'einvoice', 'compliance', 'observer', 'cli'];

  it('every publishable package has the files its package.json claims', () => {
    for (const pkg of PUBLISHABLE) {
      const dir = join(repoRoot, 'packages', pkg);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        files?: string[];
        bin?: Record<string, string>;
        engines?: { node?: string };
      };

      expect(manifest.name, `${pkg} has no name`).toBeDefined();

      // npm requires a licence per package; the root one is not enough.
      expect(
        existsSync(join(dir, 'LICENSE')),
        `${manifest.name} ships without a LICENSE, so npm shows none`,
      ).toBe(true);

      // A `files` entry that does not exist produces a broken reference in the
      // published tarball, which is how three READMEs went missing before this.
      for (const entry of manifest.files ?? []) {
        expect(
          existsSync(join(dir, entry)),
          `${manifest.name} lists "${entry}" in files, but it does not exist`,
        ).toBe(true);
      }

      expect(manifest.engines?.node, `${manifest.name} does not declare a node engine`).toBeDefined();
    }
  });

  it('the CLI declares a bin and depends on the packages it needs', () => {
    const dir = join(repoRoot, 'packages', 'cli');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.bin ?? {})).toContain('shipready');
    for (const dep of Object.keys(manifest.bin ?? {})) {
      expect(
        existsSync(join(dir, manifest.bin![dep]!)),
        `bin "${dep}" points at ${manifest.bin![dep]}, which does not exist`,
      ).toBe(true);
    }

    // These are what the CLI imports. Missing one is the 404 an installer hits.
    for (const dep of [
      '@shipready/core',
      '@shipready/observer',
      '@shipready/compliance',
      '@shipready/einvoice',
      '@shipready/rules',
    ]) {
      expect(manifest.dependencies?.[dep], `cli does not depend on ${dep}`).toBeDefined();
    }
  });

  it('keeps private packages private', () => {
    for (const pkg of ['web', 'action']) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { private?: boolean };
      expect(manifest.private, `${pkg} must stay private`).toBe(true);
    }
  });
});
  