import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `@shipready/rules` is data, not code: the packs are YAML and this module only
 * locates them on disk. Kept dependency-free so it can be required from the
 * CLI, the action, and a user's own script without pulling anything in.
 */
const here = dirname(fileURLToPath(import.meta.url));

export const PACKS_DIR = join(here, 'packs');

export interface RulePackLocation {
  id: string;
  file: string;
  absolutePath: string;
}

/** Every `.yml` pack shipped with this package. */
export function listPacks(): RulePackLocation[] {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((file) => ({
      id: file.replace(/\.ya?ml$/, ''),
      file,
      absolutePath: join(PACKS_DIR, file),
    }));
}

/** Resolve a pack by id, with or without the `.yml` suffix. */
export function resolvePack(id: string): string | null {
  const direct = join(PACKS_DIR, id);
  for (const candidate of [direct, `${direct}.yml`, `${direct}.yaml`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultPackPaths(): string[] {
  return listPacks().map((p) => p.absolutePath);
}

export const version = '0.1.0';

// `require.resolve` keeps bundlers from tree-shaking the filesystem lookups.
export const _internal = { createRequire, PACKS_DIR };