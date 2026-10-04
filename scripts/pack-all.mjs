/**
 * Pack every publishable package, in dependency order, then verify them.
 *
 * A script rather than a chained npm script: six `pnpm pack` invocations joined
 * with `&&` is a quoting minefield on Windows shells, where a stray backslash in
 * the chain is read as a path separator and pnpm then reports
 * `Unknown option: 'recursive'` with no hint that the cause is quoting.
 *
 * Order matters only for readability -- packing is local, so nothing is
 * resolved. Publish order is what matters, and that is documented in
 * docs/investor/LAUNCH.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, '.artifacts');

/** Dependency order. `cli` depends on all of the others, so it goes last. */
const PACKAGES = ['core', 'rules', 'einvoice', 'compliance', 'observer', 'cli'];

/**
 * `npm.cmd`, not `pnpm`.
 *
 * On Windows, `pnpm` resolves to `pnpm.ps1`, a PowerShell wrapper that
 * re-serialises its arguments. A path under `C:\Users\<name with a space>\...`
 * comes back mangled, and pnpm reports `Unknown option: 'recursive'` with no
 * hint that quoting is the cause. npm's `.cmd` shim passes argv through intact.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Packing ${PACKAGES.length} packages into .artifacts/\n`);

for (const name of PACKAGES) {
  const dir = join(root, 'packages', name);
  process.stdout.write(`  @shipready/${name} ... `);
  try {
    // Run inside the package directory: `npm pack` packs the cwd, and needs an
    // existing destination or it fails with ENOENT.
    //
    // `shell: true` is required on Windows: Node refuses to spawn a `.cmd`
    // shim directly (`spawnSync npm.cmd EINVAL`). The path is the repo's own
    // `.artifacts`, with no user-supplied component, so shell interpolation
    // cannot turn a package name into a command.
    const res = spawnSync(NPM, ['pack', '--pack-destination', outDir], {
      cwd: dir,
      shell: true,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`exit ${res.status}: ${(res.stderr || res.stdout || '').trim()}`);
    }
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

// Verify contents. Exits non-zero if a tarball would install broken.
execFileSync('node', [join(root, 'scripts', 'inspect-tarballs.mjs'), outDir], {
  cwd: root,
  stdio: 'inherit',
});

console.log('\nTarballs are in .artifacts/. They are not published yet --');
console.log('see docs/investor/LAUNCH.md for the publish order and the');
console.log('remaining blockers.');