import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { buildDefaultIgnoreMatcher, IgnoreMatcher, isBinaryPath } from './ignore.js';

export interface WalkOptions {
  root: string;
  /** Extra ignore text, e.g. the contents of `.shipreadyignore`. */
  extraIgnoreText?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  followSymlinks?: boolean;
  /** Directories pruned before the matcher even sees them. */
  hardExcludedDirs?: string[];
}

export interface WalkResult {
  /** Repo-relative POSIX paths, sorted for deterministic output. */
  files: string[];
  /** Directories that were skipped, for the "why" footer. */
  skippedDirs: { path: string; reason: string }[];
  truncated: boolean;
  totalVisited: number;
}

/**
 * Directories pruned before the ignore matcher sees them.
 *
 * `.shipready` is ours: scanning our own saved reports finds findings in our
 * own JSON, which is both noise and a confusing first impression.
 */
const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '.shipready',
  '.cache',
]);

/**
 * Walk a directory tree, returning repo-relative POSIX paths.
 *
 * Determinism matters more than raw speed here: a scan that visits files in a
 * different order produces a different finding order, which makes `--compare`
 * output noisy and tests flaky.
 */
export async function walk(options: WalkOptions): Promise<WalkResult> {
  const root = resolve(options.root);
  const matcher = buildDefaultIgnoreMatcher(options.extraIgnoreText);
  const includeSet = options.include?.length ? toMatcher(options.include) : null;
  const excludeSet = options.exclude?.length ? toMatcher(options.exclude) : null;
  const maxFiles = options.maxFiles ?? 20_000;

  const files: string[] = [];
  const skippedDirs: { path: string; reason: string }[] = [];
  let totalVisited = 0;
  let truncated = false;

  const hardExcluded = new Set(options.hardExcludedDirs ?? []);

  async function walkDir(absDir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip quietly rather than fail the scan
    }

    for (const entry of entries) {
      if (truncated) return;
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (!rel || rel.startsWith('..')) continue;

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const s = await stat(abs);
          if (!s.isFile() && !s.isDirectory()) continue;
          if (s.isFile()) {
            if (acceptFile(rel)) pushFile(rel);
          } else {
            await walkDir(abs);
          }
        } catch {
          continue;
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name) || hardExcluded.has(entry.name)) {
          skippedDirs.push({ path: rel, reason: 'excluded by default' });
          continue;
        }
        if (excludeSet?.(rel) || matcher.ignores(rel, true)) {
          skippedDirs.push({ path: rel, reason: 'excluded by ignore rules' });
          continue;
        }
        await walkDir(abs);
        continue;
      }

      if (entry.isFile()) {
        if (acceptFile(rel)) pushFile(rel);
      }
    }
  }

  function acceptFile(rel: string): boolean {
    if (isBinaryPath(rel)) return false;
    if (excludeSet?.(rel)) return false;
    if (matcher.ignores(rel, false)) return false;
    if (includeSet && !includeSet(rel)) return false;
    return true;
  }

  function pushFile(rel: string): void {
    totalVisited++;
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    files.push(rel);
  }

  await walkDir(root);
  files.sort();
  skippedDirs.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skippedDirs, truncated, totalVisited };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function toMatcher(patterns: string[]): (p: string) => boolean {
  const m = new IgnoreMatcher();
  for (const p of patterns) m.add(p.endsWith('/') ? p : `${p}/`);
  const exact = new Set(patterns.filter((p) => !p.endsWith('/')));
  return (rel: string) => m.ignores(rel, false) || exact.has(rel);
}

/**
 * Per-scan read cache, keyed by absolute path.
 *
 * Deliberately not module-global. A long-lived process (the dashboard, the
 * observer, a test run) would otherwise grow the cache without bound and, worse,
 * serve stale content after a file changed between scans -- which is exactly
 * what `--compare` does.
 */
export interface ReadCache {
  get(path: string): string | null | undefined;
  set(path: string, value: string | null): void;
  clear(): void;
  readonly size: number;
}

export function createReadCache(): ReadCache {
  const map = new Map<string, string | null>();
  return {
    get: (path) => map.get(path),
    set: (path, value) => {
      map.set(path, value);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

/**
 * Read a file as UTF-8, memoised in `cache`.
 *
 * Returns null for anything unreadable, and for anything binary: a NUL byte
 * means the file is not text, and scanning it produces garbage.
 */
export async function readText(absPath: string, cache?: ReadCache): Promise<string | null> {
  const cached = cache?.get(absPath);
  if (cached !== undefined) return cached;

  let content: string | null = null;
  try {
    const buf = await readFile(absPath, 'utf8');
    content = buf.includes('\u0000') ? null : buf;
  } catch {
    content = null;
  }
  cache?.set(absPath, content);
  return content;
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}
