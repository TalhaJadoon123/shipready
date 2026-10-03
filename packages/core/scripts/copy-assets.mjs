/**
 * Copy non-TypeScript assets into dist after `tsc`.
 *
 * The auto-fix templates are read at runtime with `readFileSync`, so they have
 * to sit next to the compiled output rather than beside the sources. Doing it
 * with a script keeps the build a single command and avoids adding a bundler
 * dependency for the sake of a dozen text files.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const assets = [
  { from: join(root, 'src/autofix/templates'), to: join(root, 'dist/autofix/templates') },
];

for (const asset of assets) {
  if (!existsSync(asset.from)) continue;
  mkdirSync(dirname(asset.to), { recursive: true });
  cpSync(asset.from, asset.to, { recursive: true });
  process.stdout.write(`copied ${asset.from} -> ${asset.to}\n`);
}