/**
 * Remove every build artefact.
 *
 * Replaces a `rimraf` glob, which never worked: rimraf 6 takes each argument
 * as a literal path and fails with `Illegal characters in path`. So
 * `pnpm clean` had been erroring out rather than cleaning, which is how the
 * orphaned `tsconfig.build.tsbuildinfo` files survived a "clean" and made the
 * next build a silent no-op.
 *
 * Two things matter here beyond tidiness:
 *
 *  - `dist/` and any `*.tsbuildinfo` must go together. A TypeScript incremental
 *    build whose outputs were deleted but whose buildinfo survived believes it
 *    is up to date, emits nothing, and exits 0.
 *  - `packages/web/.next` is Next.js's own cache and build output. Deleting it
 *    is slow but correct, and leaving it behind is how you end up debugging a
 *    stale bundle.
 */
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const packagesDir = join(root, 'packages');

let removed = 0;

/** Delete a path if it exists, counting it. */
function drop(path, label) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  removed++;
  console.log(`  removed ${label}`);
}

if (!existsSync(packagesDir)) {
  console.error(`No packages directory at ${packagesDir}. Run this from the repo root.`);
  process.exit(1);
}

console.log('Cleaning build artefacts\n');

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(packagesDir, entry.name);
  const name = entry.name;

  drop(join(pkgDir, 'dist'), `${name}/dist`);
  drop(join(pkgDir, '.turbo'), `${name}/.turbo`);

  // Incremental build metadata, wherever a package left it. This must never
  // outlive the outputs it describes.
  for (const stray of readdirSync(pkgDir)) {
    if (stray.endsWith('.tsbuildinfo')) drop(join(pkgDir, stray), `${name}/${stray}`);
  }

  // Next.js keeps its build output and cache here.
  if (name === 'web') drop(join(pkgDir, '.next'), 'web/.next');
}

console.log(`\nClean: ${removed} path${removed === 1 ? '' : 's'} removed.`);
console.log('Now run `pnpm build` -- `pnpm verify:build` does both and asserts the result.');