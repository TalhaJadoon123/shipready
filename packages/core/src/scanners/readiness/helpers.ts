import { internals } from '../../context.js';
import type { SourceFile } from '../../source.js';
import type { ScanContext } from '../../types.js';

export const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
export const SERVER_EXTS = ['.ts', '.js', '.mjs', '.cjs'];
export const PY_EXTS = ['.py'];
export const GO_EXTS = ['.go'];
export const RS_EXTS = ['.rs'];

export function ext(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i);
}

export function filesWithExts(ctx: ScanContext, ...exts: string[]): SourceFile[] {
  const set = new Set(exts);
  return internals.parseAll(ctx, (f) => set.has(ext(f.path)));
}

export function allFiles(ctx: ScanContext): SourceFile[] {
  return internals.parseAll(ctx, () => true);
}

/** True when the repo contains this exact path. */
export function hasFile(ctx: ScanContext, path: string): boolean {
  return ctx.files().includes(path);
}

/** True when any file in the repo ends with one of the given suffixes. */
export function hasFileMatching(ctx: ScanContext, ...suffixes: string[]): boolean {
  return ctx.files().some((f) => suffixes.some((s) => f.endsWith(s)));
}

/**
 * Indentation width of a raw (untrimmed) line.
 *
 * Rules must pass `file.lines[n - 1]`, not `file.line(n)`: `line()` trims, so
 * every indent would measure as zero and every "is this inside the try block"
 * question would answer incorrectly.
 */
export function indentOf(s: string): number {
  return s.length - s.trimStart().length;
}

/** The raw, untrimmed text of a 1-based line. */
export function rawLine(file: SourceFile, line: number): string {
  return file.lines[line - 1] ?? '';
}

export function parse(file: SourceFile): SourceFile {
  return file;
}

/**
 * Read the body of a block that starts on `line`.
 *
 * Handles brace blocks (JS/Go/Rust) and indented blocks (Python) and returns
 * null when the construct has no body, so rules can bail out cheaply.
 */
export function readBlock(file: SourceFile, line: number, maxLines = 4): string | null {
  const start = file.line(line);
  if (!start) return null;

  const openBrace = start.lastIndexOf('{');
  if (openBrace >= 0) {
    // Count braces only from the block-opening `{` onwards. A line like
    // `} catch (e) {` both closes the previous block and opens this one; if
    // the closing `}` were counted, the depth would hit zero on the opening
    // line and the body would never be read.
    let depth = 0;
    let acc = '';
    for (let l = line; l <= Math.min(file.lineCount, line + 12); l++) {
      const text = file.line(l);
      const from = l === line ? openBrace : 0;
      acc += ` ${text}`;
      for (let k = from; k < text.length; k++) {
        const ch = text[k];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth <= 0) return acc;
    }
    return acc;
  }
  if (/:?\s*$/.test(start) && !/[{)\]]\s*$/.test(start)) {
    const acc: string[] = [];
    for (let l = line + 1; l <= Math.min(file.lineCount, line + maxLines); l++) {
      const t = file.line(l);
      if (t === '') break;
      acc.push(t);
    }
    return acc.length ? acc.join('\n') : null;
  }
  return null;
}

/**
 * True when a block body is empty.
 *
 * `head` is the first line of the construct (for example `catch (e) {`), which
 * must be excluded: including it makes every `catch (e) {}` look non-empty.
 */
export function isBlankBlock(s: string, head: string): boolean {
  let body = s;
  const start = s.indexOf(head);
  if (start >= 0) body = s.slice(start + head.length);
  // Drop the opening delimiter that the slice may have left behind.
  body = body.replace(/^\s*[:{)\]]*/, ' ').replace(/[;{}]/g, ' ');
  return body.trim() === '';
}

/**
 * True when `line` sits inside a `try`/`finally` block in the same function.
 *
 * Uses raw (untrimmed) lines: the indent of the `try` must be strictly less
 * than the indent of the statement, and `SourceFile.line()` trims.
 */
export function isInsideTryBlock(file: SourceFile, line: number): boolean {
  const indent = indentOf(rawLine(file, line));
  for (let l = line - 1; l >= 1 && l >= line - 60; l--) {
    const raw = rawLine(file, l);
    const code = file.lineNoComments(l);
    if (code === '') continue;
    const rawIndent = indentOf(raw);
    if (rawIndent >= indent) continue;
    if (/(^|\s)(try|finally)\b/.test(code)) return true;
    // A function or class boundary ends the search.
    if (/^(?:export\s+)?(?:async\s+)?(?:function|class|def)\b/.test(code)) return false;
    if (/^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/.test(code)) return false;
  }
  return false;
}

/**
 * Best guess at a server entrypoint, used to anchor repo-level findings.
 *
 * Falls back through known entry names, then any file that *looks* like an
 * entry, then the first source file. It deliberately avoids anchoring on
 * `.env.example` or a lockfile: a finding that says "no CSRF defence" and then
 * points at your env template sends the reader in the wrong direction.
 */
export function findServerEntry(ctx: ScanContext): string {
  const files = [...ctx.files()];
  const preferred = [
    'server.ts',
    'server.js',
    'src/server.ts',
    'src/server.js',
    'index.ts',
    'index.js',
    'src/index.ts',
    'src/index.js',
    'app.ts',
    'app.js',
    'src/app.ts',
    'src/app/index.ts',
    'main.py',
    'app/main.py',
    'main.go',
    'cmd/main.go',
    'src/main.rs',
    'src/main.ts',
  ];
  for (const p of preferred) if (files.includes(p)) return p;

  const entryLike = /(^|\/)(server|app|main|index|__main__)\.(ts|js|mjs|cjs|py|go|rs)$/;
  const hit = files.find((f) => entryLike.test(f) && !/\.(test|spec)\./.test(f));
  if (hit) return hit;

  // Last resort: a real source file, so the finding points somewhere useful.
  const source = files.find((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(f) && !/\.(test|spec)\./.test(f));
  if (source) return source;

  return files.find((f) => f === 'package.json') ?? files[0] ?? '.';
}

const ENTRY_ANCHOR = 'package.json' as const;

/** Path to anchor a repo-level finding on, preferring a real file. */
export function anchorPath(ctx: ScanContext, preferred: readonly string[] = []): string {
  const files = new Set(ctx.files());
  for (const p of preferred) if (files.has(p)) return p;
  if (files.has(ENTRY_ANCHOR)) return ENTRY_ANCHOR;
  return findServerEntry(ctx);
}

export function hasDependency(ctx: ScanContext, ...names: string[]): boolean {
  return names.some((n) => ctx.project.dependencyNames.has(n));
}

export function countMatches(files: readonly SourceFile[], re: RegExp): number {
  let n = 0;
  for (const f of files) n += f.matchNoComments(re).length;
  return n;
}

export function anyFileMatches(files: readonly SourceFile[], re: RegExp): boolean {
  return files.some((f) => re.test(f.noComments));
}

/** Concatenated comment-free source for repo-wide `has X?` questions. */
export function joinedCode(files: readonly SourceFile[], re: RegExp): boolean {
  return files.some((f) => re.test(f.noComments));
}

export function firstLineMatching(file: SourceFile, re: RegExp): number {
  for (let i = 1; i <= file.lineCount; i++) if (re.test(file.lineNoComments(i))) return i;
  return 1;
}

export function hasCommentMentioning(files: readonly SourceFile[], needle: string): boolean {
  const n = needle.toLowerCase();
  return files.some((f) => f.comments.some((c) => c.text.toLowerCase().includes(n)));
}

/** Human label for the detected stack, for evidence summaries. */
export function stackLabel(ctx: ScanContext): string {
  switch (ctx.project.type) {
    case 'nextjs':
      return 'Next.js';
    case 'express':
      return 'Express/Node';
    case 'fastapi':
      return 'FastAPI';
    case 'django':
      return 'Django';
    case 'go':
      return 'Go';
    case 'rust':
      return 'Rust';
    case 'vite':
      return 'Vite';
    case 'python':
      return 'Python';
    case 'node':
      return 'Node.js';
    default:
      return ctx.project.frameworks[0] ?? 'the project';
  }
}
