import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProductionReadinessReport } from '../types.js';
import type { FileFix } from './index.js';

export const DEFAULT_HISTORY_LIMIT = 20;

export function reportPath(root: string = process.cwd()): string {
  return join(resolve(root), '.shipready', 'last-scan.json');
}

export function historyDir(root: string = process.cwd()): string {
  return join(resolve(root), '.shipready', 'history');
}

/**
 * Persist a report so the next run can diff against it.
 *
 * History is capped at 20 files: enough to see a trend, small enough that
 * nobody's `.shipready` directory becomes a thing they have to gitignore.
 */
export async function writeReport(
  report: ProductionReadinessReport,
  root: string = process.cwd(),
): Promise<string> {
  const last = reportPath(root);
  await mkdir(dirname(last), { recursive: true });
  await writeFile(last, JSON.stringify(report, null, 2), 'utf8');

  const dir = historyDir(root);
  try {
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - DEFAULT_HISTORY_LIMIT))) {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(dir, stale)).catch(() => undefined);
    }
  } catch {
    // History is a convenience; failing to write it must not fail the scan.
  }
  return last;
}

/**
 * Load the previous report for `--compare`.
 *
 * A missing file is not an error -- it is simply the first run.
 */
export async function readLastReport(
  root: string = process.cwd(),
): Promise<ProductionReadinessReport | null> {
  try {
    const text = await readFile(reportPath(root), 'utf8');
    const parsed = JSON.parse(text) as ProductionReadinessReport;
    if (typeof parsed?.score !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listHistory(root: string = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(historyDir(root));
    return entries.filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export interface ApplyResult {
  written: { path: string; kind: FileFix['kind']; bytes: number }[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
}

/**
 * Apply generated fixes.
 *
 * Default behaviour is `--dry-run`: print what would happen and change
 * nothing. Writing generated files into someone's repository without them
 * reading the diff is how you lose their trust permanently, so the CLI has to
 * opt in explicitly.
 *
 * Patches are all-or-nothing per file: if the anchor text is missing or
 * appears more than once, the whole file is skipped rather than patched
 * ambiguously.
 */
export async function applyFixes(
  fixes: readonly FileFix[],
  options: { dryRun?: boolean; root?: string } = {},
): Promise<ApplyResult> {
  const root = resolve(options.root ?? process.cwd());
  const result: ApplyResult = { written: [], skipped: [], failed: [] };
  const byPath = new Map<string, FileFix[]>();

  for (const fix of fixes) {
    const arr = byPath.get(fix.path);
    if (arr) arr.push(fix);
    else byPath.set(fix.path, [fix]);
  }

  for (const [path, pathFixes] of byPath) {
    const abs = join(root, path);
    const creates = pathFixes.filter((f) => f.kind === 'create');
    const patches = pathFixes.filter((f) => f.kind === 'patch' || f.kind === 'append');

    try {
      if (creates.length > 0 && patches.length > 0) {
        result.skipped.push({ path, reason: 'fixes mix "create" and "patch" for the same file; apply separately' });
        continue;
      }

      if (creates.length > 0) {
        let content = creates[0]!.content ?? '';
        for (const extra of creates.slice(1)) content += `\n${extra.content ?? ''}`;
        if (!options.dryRun) {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content, 'utf8');
        }
        result.written.push({ path, kind: 'create', bytes: Buffer.byteLength(content) });
        continue;
      }

      let existing: string;
      try {
        existing = await readFile(abs, 'utf8');
      } catch {
        result.skipped.push({ path, reason: 'patch target does not exist; nothing to modify' });
        continue;
      }

      let content = existing;
      let ok = true;
      for (const patch of patches) {
        if (patch.kind === 'append') {
          content += `\n${patch.content ?? ''}`;
          continue;
        }
        const find = patch.find ?? '';
        const replace = patch.replace ?? '';
        if (!find) {
          result.failed.push({ path, reason: 'patch has no anchor text' });
          ok = false;
          break;
        }
        const occurrences = countOccurrences(content, find);
        if (occurrences === 0) {
          result.failed.push({ path, reason: `anchor text not found: ${truncate(find, 60)}` });
          ok = false;
          break;
        }
        if (occurrences > 1) {
          result.failed.push({ path, reason: `anchor text found ${occurrences} times; refusing to guess` });
          ok = false;
          break;
        }
        content = content.replace(find, replace);
      }
      if (!ok) continue;

      if (!options.dryRun) await writeFile(abs, content, 'utf8');
      result.written.push({ path, kind: patches[0]!.kind, bytes: Buffer.byteLength(content) });
    } catch (error) {
      result.failed.push({ path, reason: (error as Error).message });
    }
  }

  return result;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}