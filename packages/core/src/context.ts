import { join, resolve } from 'node:path';
import { detectProject } from './fsutil/detect.js';
import { createReadCache, pathExists, readText, walk, type WalkResult } from './fsutil/walk.js';
import type { PluginRegistryLike } from './types.js';
import { SourceFile } from './source.js';
import { DEFAULT_SCAN_CONFIG } from './config.js';
import type { ScanConfig, ScanContext, ScanTarget } from './types.js';

/**
 * Builds the shared `ScanContext` handed to every scanner.
 *
 * Two deliberate choices:
 *  1. File contents are loaded once, eagerly, into a `Map<string, SourceFile>`.
 *     Fifty-plus rules over a 2,000-file repo would otherwise re-read the same
 *     files fifty times, and rules need synchronous access to be simple.
 *  2. Project detection happens exactly once. Rules read `context.project`
 *     rather than sniffing `package.json` themselves, which is what keeps
 *     "is this a Next.js app" a single consistent answer across all rules.
 */
export async function createScanContext(
  target: ScanTarget,
  registry: PluginRegistryLike,
): Promise<ScanContext> {
  const root = resolve(target.path ?? '.');
  const config: ScanConfig = { ...DEFAULT_SCAN_CONFIG, ...(target.config ?? {}) };
  const warnings: string[] = [];

  const walkResult: WalkResult = await walk({
    root,
    include: target.include,
    exclude: target.exclude,
    maxFiles: config.maxFiles,
  });
  if (walkResult.truncated) {
    warnings.push(
      `File limit of ${config.maxFiles ?? 20_000} reached. ` +
        `Raise it with --max-files if the scan looks incomplete.`,
    );
  }

  const sources = new Map<string, SourceFile>();
  const fileSet = new Set(walkResult.files);
  // A fresh cache per scan, so two scans of the same tree in one process never
  // see each other's reads.
  const readCache = createReadCache();

  async function load(rel: string): Promise<string | null> {
    const text = await readText(join(root, rel), readCache);
    if (text === null) return null;
    sources.set(rel, new SourceFile(rel, text));
    return text;
  }

  await Promise.all(walkResult.files.map((f) => load(f)));

  const byExtension = new Map<string, string[]>();
  for (const f of walkResult.files) {
    const dot = f.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = f.slice(dot);
    const arr = byExtension.get(ext);
    if (arr) arr.push(f);
    else byExtension.set(ext, [f]);
  }

  const project = await detectProject(root, walkResult.files, load);

  const ctx: ScanContext = {
    target,
    project,
    async readFile(relPath: string): Promise<string | null> {
      const hit = sources.get(relPath);
      if (hit) return hit.content;
      if (!fileSet.has(relPath)) return null;
      return load(relPath);
    },
    async exists(relPath: string): Promise<boolean> {
      if (fileSet.has(relPath)) return true;
      return pathExists(join(root, relPath));
    },
    files(): readonly string[] {
      return walkResult.files;
    },
    filter(predicate: (path: string) => boolean): readonly string[] {
      return walkResult.files.filter(predicate);
    },
    config,
    warn(message: string): void {
      warnings.push(message);
    },
    registry,
  };

  // Internal, non-enumerable accessors. Kept off the public shape so a context
  // can be JSON-serialised for debugging without dragging a whole file cache.
  defineHidden(ctx, 'root', root);
  defineHidden(ctx, 'walkResult', walkResult);
  defineHidden(ctx, 'warnings', warnings);
  defineHidden(ctx, 'sources', sources);
  defineHidden(ctx, 'byExtension', byExtension);
  return ctx;
}

function defineHidden(ctx: ScanContext, key: string, value: unknown): void {
  Object.defineProperty(ctx, key, { value, enumerable: false, writable: false });
}

type Hidden<T> = { [K in keyof T]: T[K] } & Record<string, unknown>;

/** Internal accessors. Not part of the public API; may change between releases. */
export const internals = {
  root(ctx: ScanContext): string {
    return (ctx as unknown as Hidden<ScanContext>).root as string;
  },
  walkResult(ctx: ScanContext): WalkResult {
    return (ctx as unknown as Hidden<ScanContext>).walkResult as WalkResult;
  },
  warnings(ctx: ScanContext): string[] {
    return ((ctx as unknown as Hidden<ScanContext>).warnings as string[]) ?? [];
  },
  source(ctx: ScanContext, path: string): SourceFile | null {
    const map = (ctx as unknown as Hidden<ScanContext>).sources as Map<string, SourceFile>;
    return map.get(path) ?? null;
  },
  /** Parse a file, or return null. This is the entry point rules should use. */
  parse(ctx: ScanContext, path: string): SourceFile | null {
    return internals.source(ctx, path);
  },
  byExtension(ctx: ScanContext, ext: string): string[] {
    const map = (ctx as unknown as Hidden<ScanContext>).byExtension as Map<string, string[]>;
    return map.get(ext) ?? [];
  },
  /** Every parsed file matching a predicate. */
  parseAll(ctx: ScanContext, predicate: (file: SourceFile) => boolean): SourceFile[] {
    const map = (ctx as unknown as Hidden<ScanContext>).sources as Map<string, SourceFile>;
    const out: SourceFile[] = [];
    for (const file of map.values()) if (predicate(file)) out.push(file);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  },
};

export type { ScanContext };
