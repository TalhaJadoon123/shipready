/**
 * Inspect the packed tarballs.
 *
 * `files` in package.json is a promise: npm includes exactly those paths. A
 * listed path that does not exist produces a broken reference in the published
 * package, and nothing catches it until someone installs it -- which is how
 * @shipready/einvoice shipped a `schemas` entry for a directory that never
 * existed.
 *
 * Usage:
 *   node scripts/inspect-tarballs.mjs <dir-containing-tgz>
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/inspect-tarballs.mjs <dir-containing-tgz>');
  process.exit(2);
}

const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
if (tarballs.length === 0) {
  console.error(`No .tgz files in ${dir}`);
  process.exit(1);
}

let problems = 0;

for (const file of tarballs.sort()) {
  const listing = execFileSync('tar', ['-tzf', join(dir, file)], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // tar lists entries as `package/...` and sometimes with a trailing slash for
  // directories, so match on the prefix rather than exact equality.
  const has = (needle) => listing.some((l) => l.replace(/\/$/, '') === needle || l.startsWith(needle));
  const distFiles = listing.filter((l) => l.startsWith('package/dist/')).length;
  // npm rewrites `@shipready/cli` to `shipready-cli` in the tarball name.
  const isData = file.startsWith('shipready-rules');

  console.log(`\n${file}  (${listing.length} entries)`);

  const checks = [
    ['package.json', has('package/package.json')],
    ['LICENSE', has('package/LICENSE')],
    ['README.md', has('package/README.md')],
    // `rules` ships rule packs as data, so it legitimately has no dist/.
    ['dist/ build output', isData || distFiles > 0],
  ];

  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'MISS'} ${label}`);
    if (!ok) problems++;
  }

  if (distFiles > 0) console.log(`       ${distFiles} files under dist/`);

  // The bin entry has to point at something that is actually in the tarball.
  if (file.startsWith('shipready-cli')) {
    const binOk = has('package/bin/shipready.mjs');
    console.log(`  ${binOk ? 'ok  ' : 'MISS'} bin/shipready.mjs`);
    if (!binOk) problems++;
    // The bin is a thin wrapper; the compiled entry it loads must be present.
    const entryOk = listing.some((l) => l.startsWith('package/dist/') && l.endsWith('.js'));
    console.log(`  ${entryOk ? 'ok  ' : 'MISS'} compiled entrypoint the bin loads`);
    if (!entryOk) problems++;
  }

  // @shipready/observer loads this by path at runtime, so a missing preload
  // means `shipready observe` fails with "preload not found" on a clean install.
  if (file.startsWith('shipready-observer')) {
    const preloadOk = has('package/preload.cjs');
    console.log(`  ${preloadOk ? 'ok  ' : 'MISS'} preload.cjs (loaded by path at runtime)`);
    if (!preloadOk) problems++;
  }
}

console.log(
  problems === 0
    ? '\nAll tarballs contain package.json, LICENSE, README.md and build output.'
    : `\n${problems} problem(s). These tarballs would install broken.`,
);
process.exit(problems === 0 ? 0 : 1);