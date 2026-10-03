/**
 * Lightweight, allocation-cheap source analysis.
 *
 * ShipReady's rules are heuristic and pattern based by design: a full AST for
 * every supported language would be a huge dependency surface, would need
 * recompilation per language, and would make the rules far harder to write.
 * What rules actually need is (a) the raw text, (b) the text with comments
 * removed so a comment mentioning `rateLimit` does not read as
 * `rateLimit(...)`, and (c) a fast way to answer "which line is this offset
 * on". That is what this module provides.
 *
 * `maskComments` preserves string literals on purpose. Several rules need to
 * read the text inside a prompt template in order to detect injection
 * surfaces, so the default mask only blanks comments.
 */

export type Language =
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'mjs'
  | 'cjs'
  | 'py'
  | 'go'
  | 'rs'
  | 'rb'
  | 'php'
  | 'java'
  | 'cs'
  | 'sql'
  | 'sh'
  | 'yaml'
  | 'toml'
  | 'json'
  | 'xml'
  | 'html'
  | 'css'
  | 'md'
  | 'unknown';

const EXTENSION_LANGUAGE: Record<string, Language> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.rb': 'rb',
  '.php': 'php',
  '.java': 'java',
  '.cs': 'cs',
  '.sql': 'sql',
  '.sh': 'sh',
  '.bash': 'sh',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.md': 'md',
};

export function languageOf(path: string): Language {
  // Handle .d.ts and .test.ts style suffixes by taking the last extension.
  const idx = path.toLowerCase().lastIndexOf('.');
  if (idx < 0) return 'unknown';
  return EXTENSION_LANGUAGE[path.toLowerCase().slice(idx)] ?? 'unknown';
}

export function isTypeScript(path: string): boolean {
  const lang = languageOf(path);
  return lang === 'ts' || lang === 'tsx';
}

export function isJavaScriptLike(path: string): boolean {
  const lang = languageOf(path);
  return lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx' || lang === 'mjs' || lang === 'cjs';
}

interface CommentSyntax {
  line: string[];
  block: [string, string][];
}

const COMMENT_SYNTAX: Partial<Record<Language, CommentSyntax>> = {
  ts: { line: ['//'], block: [['/*', '*/']] },
  tsx: { line: ['//'], block: [['/*', '*/']] },
  js: { line: ['//'], block: [['/*', '*/']] },
  jsx: { line: ['//'], block: [['/*', '*/']] },
  py: { line: ['#'], block: [] },
  go: { line: ['//'], block: [['/*', '*/']] },
  rs: { line: ['//'], block: [['/*', '*/']] },
  rb: { line: ['#'], block: [] },
  php: { line: ['//', '#'], block: [['/*', '*/']] },
  java: { line: ['//'], block: [['/*', '*/']] },
  cs: { line: ['//'], block: [['/*', '*/']] },
  sql: { line: ['--'], block: [['/*', '*/']] },
  sh: { line: ['#'], block: [] },
  yaml: { line: ['#'], block: [] },
  toml: { line: ['#'], block: [] },
  css: { line: ['//'], block: [['/*', '*/']] },
};

const QUOTES = new Set(['"', "'", '`']);

/**
 * Replace comment bodies with spaces, preserving every byte offset and newline
 * so line numbers computed from the masked text match the original.
 */
export function maskComments(content: string, lang: Language = 'unknown'): string {
  const syntax = COMMENT_SYNTAX[lang] ?? COMMENT_SYNTAX.ts!;
  const out = content.split('');
  const len = content.length;
  let i = 0;
  // Start of the current line, so `//` inside a URL string can be rejected.
  let lineStart = 0;
  // Position at the top of each iteration, guaranteeing forward progress.
  let loopStart = 0;

  /** True when the quote state at `pos` puts us inside a string literal. */
  const isInsideString = (pos: number): boolean => {
    let quote: string | null = null;
    for (let k = lineStart; k < pos; k++) {
      const ch = content[k];
      if (quote === null) {
        if (QUOTES.has(ch!)) quote = ch!;
      } else if (ch === quote && (k === 0 || content[k - 1] !== '\\')) {
        quote = null;
      }
    }
    return quote !== null;
  };

  while (i < len) {
    const ch = content[i]!;
    loopStart = i;

    if (ch === '\n') {
      i++;
      lineStart = i;
      continue;
    }

    // String or template literal.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < len) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        if (content[i] === '\n' && quote !== '`') break;
        i++;
      }
      continue;
    }

    // Block comment.
    let matchedBlock = false;
    for (const [open, close] of syntax.block) {
      if (!content.startsWith(open, i)) continue;
      const end = content.indexOf(close, i + open.length);
      const stop = end === -1 ? len : end + close.length;
      for (let k = i; k < stop; k++) if (content[k] !== '\n') out[k] = ' ';
      i = stop;
      matchedBlock = true;
      break;
    }
    if (matchedBlock) continue;

    // Line comment.
    for (const marker of syntax.line) {
      if (!content.startsWith(marker, i)) continue;
      let stop = i;
      while (stop < len && content[stop] !== '\n') stop++;
      if (isInsideString(i)) {
        // Leave the marker alone, but consume it so we still make progress.
        i += marker.length;
      } else {
        for (let k = i; k < stop; k++) out[k] = ' ';
        i = stop;
      }
      break;
    }

    // Nothing matched at this position: advance, or the loop never ends.
    if (i === loopStart) i++;
  }

  return out.join('');
}

/**
 * Mask comments and string bodies.
 *
 * Template literal *text* is blanked but `${ ... }` interpolations are kept,
 * because rules need to see what a template actually interpolates.
 */
export function maskCommentsAndStrings(content: string, lang: Language = 'unknown'): string {
  const out = maskComments(content, lang).split('');
  const len = content.length;
  let i = 0;

  while (i < len) {
    const ch = content[i]!;

    if (ch === '`') {
      i++;
      while (i < len) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '`') {
          i++;
          break;
        }
        if (content[i] === '$' && content[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            const d = content[i];
            if (d === '{') depth++;
            else if (d === '}') depth--;
            else if (d === '\n') break;
            i++;
          }
          continue;
        }
        if (content[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let k = i + 1;
      while (k < len) {
        if (content[k] === '\\') {
          k += 2;
          continue;
        }
        if (content[k] === quote || content[k] === '\n') break;
        k++;
      }
      for (let j = i + 1; j < k; j++) if (content[j] !== '\n') out[j] = ' ';
      i = k + 1;
      continue;
    }

    i++;
  }

  return out.join('');
}

export interface CommentRecord {
  line: number;
  text: string;
  /** True for block comments and docstrings, which usually carry intent. */
  block: boolean;
}

/**
 * Extract comments so rules can look for "the code already handles this".
 *
 * Each line is scanned left to right with quote tracking, so a `//` inside a
 * URL or a `#` inside a hex colour is never mistaken for a comment.
 */
export function extractComments(content: string, lang: Language = 'unknown'): CommentRecord[] {
  const records: CommentRecord[] = [];
  const syntax = COMMENT_SYNTAX[lang] ?? COMMENT_SYNTAX.ts!;
  const lines = lineTexts(content);

  for (const [open, close] of syntax.block) {
    const re = new RegExp(`${escapeRe(open)}([\\s\\S]*?)${escapeRe(close)}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const text = m[1]!.replace(/^\s*\*?/gm, '').trim();
      if (text) records.push({ line: lineOfOffset(content, m.index), text, block: true });
    }
  }

  const markers = syntax.line;
  if (markers.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let quote: string | null = null;
      for (let k = 0; k < line.length; k++) {
        const ch = line[k]!;
        if (quote !== null) {
          if (ch === '\\') {
            k++;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }
        if (QUOTES.has(ch)) {
          quote = ch;
          continue;
        }
        const marker = markers.find((candidate) => line.startsWith(candidate, k));
        if (!marker) continue;
        const text = line.slice(k + marker.length).trim();
        if (text) records.push({ line: i + 1, text, block: false });
        break;
      }
    }
  }

  return records.sort((a, b) => a.line - b.line);
}

export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, content.length);
  for (let i = 0; i < stop; i++) if (content[i] === '\n') line++;
  return line;
}

export function lineText(content: string, line: number): string {
  return (content.split(/\r?\n/)[line - 1] ?? '').trim();
}

export function lineTexts(content: string): string[] {
  return content.split(/\r?\n/);
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

export interface LineMatch {
  /** 1-based line number. */
  line: number;
  /** The whole line, trimmed. */
  text: string;
  /** Offset of the match within the line, 0-based. */
  column: number;
  /** The matched text. */
  match: string;
  /** Byte offset of the match within the whole file. */
  index: number;
}

/** Run a per-line regex and return every hit with its line number and offset. */
export function matchLines(content: string, re: RegExp): LineMatch[] {
  const lines = lineTexts(content);
  const lineIndex = buildLineIndex(content);
  const results: LineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) {
        rx.lastIndex++;
        continue;
      }
      results.push({
        line: i + 1,
        text: text.trim(),
        column: m.index,
        match: m[0],
        index: lineIndex.starts[i]! + m.index,
      });
    }
  }
  return results;
}

/**
 * Run a regex over the whole text, mapping each match back to a line.
 *
 * `source` defaults to `content`. Pass the original text when the line index
 * and offsets should come from `content` while the match runs over a masked
 * copy.
 */
export function matchAll(
  content: string,
  re: RegExp,
  source: string = content,
): LineMatch[] {
  const lineIndex = buildLineIndex(content);
  const allLines = lineTexts(content);
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const results: LineMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) {
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    const { line, column } = locate(lineIndex, m.index);
    results.push({
      index: m.index,
      line,
      column,
      text: (allLines[line - 1] ?? '').trim(),
      match: m[0],
    });
  }
  return results;
}

interface LineIndex {
  starts: number[];
}

function buildLineIndex(content: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return { starts };
}

function locate(index: LineIndex, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - index.starts[lo]! };
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A reusable, cached view over one source file. */
export class SourceFile {
  readonly path: string;
  readonly content: string;
  readonly language: Language;
  /** Comments blanked, byte offsets preserved. */
  readonly noComments: string;
  /** Comments and string bodies blanked. */
  readonly noCommentsOrStrings: string;
  readonly lines: string[];
  readonly comments: CommentRecord[];
  private readonly lineIndex: LineIndex;

  constructor(path: string, content: string) {
    this.path = path;
    this.content = content;
    this.language = languageOf(path);
    this.noComments = maskComments(content, this.language);
    this.noCommentsOrStrings = maskCommentsAndStrings(content, this.language);
    this.lines = content.split(/\r?\n/);
    this.comments = extractComments(content, this.language);
    this.lineIndex = buildLineIndex(content);
  }

  line(n: number): string {
    return (this.lines[n - 1] ?? '').trim();
  }

  lineNoComments(n: number): string {
    return (this.noComments.split(/\r?\n/)[n - 1] ?? '').trim();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  locate(offset: number): { line: number; column: number } {
    return locate(this.lineIndex, offset);
  }

  match(re: RegExp): LineMatch[] {
    return matchLines(this.content, re);
  }

  matchNoComments(re: RegExp): LineMatch[] {
    return matchLines(this.noComments, re);
  }

  /**
   * Match against comment-free text. `source` lets a rule read a window of the
   * original content around a hit -- for example, to see what a template
   * literal interpolated.
   */
  matchCode(re: RegExp, source?: string): LineMatch[] {
    return matchAll(this.noComments, re, source ?? this.noComments);
  }

  /** The original content around an offset, for context in a rule. */
  windowAround(offset: number, radius = 600): string {
    return this.content.slice(Math.max(0, offset - radius), Math.min(this.content.length, offset + radius));
  }

  /**
   * True when this line, or the lines just above it, carry a comment explaining
   * why the code looks the way it does. Used to suppress findings a human has
   * already consciously accepted.
   */
  hasExplanatoryCommentNear(line: number, needles: readonly string[], lookback = 2): boolean {
    for (let l = line; l > Math.max(0, line - lookback); l--) {
      for (const c of this.comments) {
        if (c.line < l || c.line > l + 1) continue;
        const text = c.text.toLowerCase();
        if (needles.some((n) => text.includes(n.toLowerCase()))) return true;
      }
    }
    return false;
  }

  /** `shipready-disable-next-line [rule-id]` / `shipready-disable [rule-id]`. */
  isSuppressed(line: number, ruleId?: string): boolean {
    for (const c of this.comments) {
      if (c.line < line - 1 || c.line > line) continue;
      if (!/shipready-disable/.test(c.text)) continue;
      if (!ruleId) return true;
      const scope = c.text.replace(/shipready-disable(-next-line)?/g, '').trim();
      if (!scope) return true;
      if (scope.split(/[\s,]+/).includes(ruleId)) return true;
    }
    return false;
  }
}

/**
 * A lazily-populated bag of parsed files, for callers that do their own
 * walking. The scan engine pre-loads everything instead; this exists for tools
 * that touch one or two files.
 */
export class SourceSet {
  private readonly cache = new Map<string, SourceFile | null>();

  private constructor(private readonly loader: (path: string) => string | null) {}

  static fromLoader(loader: (path: string) => string | null): SourceSet {
    return new SourceSet(loader);
  }

  get(path: string): SourceFile | null {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const content = this.loader(path);
    const file = content === null ? null : new SourceFile(path, content);
    this.cache.set(path, file);
    return file;
  }
}