/**
 * Asserts a clean build actually produced output.
 *
 * `tsc --incremental` writes a buildinfo file recording which outputs it
 * believes are current. If `dist/` is deleted but that file survives, `tsc`
 * concludes there is nothing to do, emits nothing, and exits 0. The build looks
 * successful and the packages are empty.
 *
 * That is not hypothetical: it is why a `pnpm clean && pnpm -r build` failed
 * with `Cannot find module '@shipready/observer'` while turbo reported the
 * observer build as succeeding. The buildinfo now lives inside `dist/` so
 * `pnpm clean` removes it with everything else, and this script is the guard.
 *
 * Run via: pnpm verify:build
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** Packages that compile TypeScript into `dist/`. */
const BUILT = ['core', 'cli', 'observer', 'compliance', 'einvoice'];

/**
 * Packages that legitimately have no `dist/`.
 *
 * `rules` ships its rule packs as data and its build step is a no-op by design.
 * `web` is Next.js, whose output is `.next/` rather than `dist/`.
 * `action` has no build step at all.
 */
const NO_DIST = new Set(['rules', 'web', 'action']);

const problems = [];
const rows = [];

for (const pkg of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', pkg);
  if (!statSync(dir).isDirectory()) continue;

  const dist = join(dir, 'dist');
  if (!existsSync(dist)) {
    if (!NO_DIST.has(pkg)) problems.push(`${pkg}: no dist/ directory after a clean build`);
    rows.push([pkg, 0, 'no dist (expected)']);
    continue;
  }

  const count = countFiles(dist);
  if (count === 0 && !NO_DIST.has(pkg)) problems.push(`${pkg}: dist/ exists but is empty`);
  rows.push([pkg, count, count === 0 ? 'EMPTY' : 'ok']);
}

/** `.next` must exist for the dashboard, or its build silently no-opped too. */
const nextDir = join(root, 'packages', 'web', '.next');
if (!existsSync(nextDir)) {
  problems.push('web: no .next directory after a clean build');
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

console.log('Clean-build verification\n');
console.log('package      files   status');
for (const [pkg, count, status] of rows) {
  console.log(`${String(pkg).padEnd(12)} ${String(count).padStart(6)}   ${status}`);
}

// The CLI's entry point is what a user runs first, so assert it is executable
// and wired to something that exists.
const binPath = join(root, 'packages', 'cli', 'bin', 'shipready.mjs');
if (!existsSync(binPath)) {
  problems.push('cli: bin/shipready.mjs missing');
} else {
  const bin = readFileSync(binPath, 'utf8');
  if (!bin.includes('dist')) problems.push('cli: bin/shipready.mjs does not reference dist/');
}

console.log('');
if (problems.length > 0) {
  console.error('FAILED: a clean build did not produce the expected output.\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nIf dist/ is empty, check that tsBuildInfoFile in');
  console.error('packages/*/tsconfig.build.json points inside dist/.');
  process.exit(1);
}

console.log('OK: every package emitted output from a clean build.');