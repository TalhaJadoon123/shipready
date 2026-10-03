import { describe, expect, it } from 'vitest';
import {
  extractComments,
  languageOf,
  lineOfOffset,
  lineText,
  maskComments,
  maskCommentsAndStrings,
  matchAll,
  matchLines,
  SourceFile,
} from '../src/source.js';

describe('languageOf', () => {
  it('maps extensions to languages', () => {
    expect(languageOf('a.ts')).toBe('ts');
    expect(languageOf('a.tsx')).toBe('tsx');
    expect(languageOf('a.py')).toBe('py');
    expect(languageOf('a.go')).toBe('go');
    expect(languageOf('a.rs')).toBe('rs');
    expect(languageOf('a.sql')).toBe('sql');
    expect(languageOf('a.yml')).toBe('yaml');
    expect(languageOf('Dockerfile')).toBe('unknown');
    expect(languageOf('Makefile')).toBe('unknown');
  });

  it('uses the last extension for compound suffixes', () => {
    expect(languageOf('types.d.ts')).toBe('ts');
    expect(languageOf('a.test.tsx')).toBe('tsx');
  });

  it('is case insensitive', () => {
    expect(languageOf('README.MD')).toBe('md');
    expect(languageOf('A.PY')).toBe('py');
  });
});

describe('maskComments', () => {
  it('removes a line comment but preserves offsets and newlines', () => {
    const src = 'const a = 1; // set a\nconst b = 2;\n';
    const masked = maskComments(src, 'ts');
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n')).toHaveLength(src.split('\n').length);
    expect(masked).not.toContain('set a');
    expect(masked).toContain('const a = 1;');
  });

  it('removes a block comment across lines', () => {
    const src = 'const a = 1;\n/* line one\n   line two */\nconst b = 2;\n';
    const masked = maskComments(src, 'ts');
    expect(masked).not.toContain('line one');
    expect(masked).toContain('const b = 2;');
    expect(masked).toHaveLength(src.length);
  });

  it('leaves a double slash inside a string alone', () => {
    const src = 'const url = "https://example.com/a";\n';
    expect(maskComments(src, 'ts')).toContain('https://example.com/a');
  });

  it('leaves a double slash inside a template literal alone', () => {
    const src = 'const s = `see https://x.com // y`;\n';
    expect(maskComments(src, 'ts')).toContain('// y');
  });

  it('handles python hash comments', () => {
    const src = 'x = 1  # note\ny = 2\n';
    const masked = maskComments(src, 'py');
    expect(masked).not.toContain('note');
    expect(masked).toContain('x = 1');
  });

  it('does not treat a hash inside a python string as a comment', () => {
    const src = 'color = "#ff0000"\n';
    expect(maskComments(src, 'py')).toContain('#ff0000');
  });

  it('handles an unterminated block comment without hanging', () => {
    const src = 'const a = 1;\n/* never closed\nconst b = 2;\n';
    const masked = maskComments(src, 'ts');
    expect(masked).toHaveLength(src.length);
  });

  it('is idempotent', () => {
    const src = '// one\nconst a = 1; // two\n';
    const once = maskComments(src, 'ts');
    expect(maskComments(once, 'ts')).toBe(once);
  });
});

describe('maskCommentsAndStrings', () => {
  it('blanks string bodies while keeping quotes', () => {
    const masked = maskCommentsAndStrings("const a = 'hello';", 'ts');
    expect(masked).toContain("'");
    expect(masked).not.toContain('hello');
  });

  it('preserves line count', () => {
    const src = "const a = 'x';\nconst b = `y\nz`;\nconst c = 3;\n";
    const masked = maskCommentsAndStrings(src, 'ts');
    expect(masked.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('does not blank code inside a template interpolation', () => {
    const src = 'const v = `count: ${countItems(items)}`;';
    const masked = maskCommentsAndStrings(src, 'ts');
    expect(masked).not.toContain('count: ');
    // The braces are preserved even though the literal text is blanked.
    expect(masked).toContain('${');
  });
});

describe('extractComments', () => {
  it('finds line and block comments with line numbers', () => {
    const src = '// first\nconst a = 1;\n/* second */\nconst b = 2;\n';
    const comments = extractComments(src, 'ts');
    const texts = comments.map((c) => c.text);
    expect(texts).toContain('first');
    expect(texts).toContain('second');
    expect(comments.find((c) => c.text === 'first')?.line).toBe(1);
    expect(comments.find((c) => c.text === 'second')?.block).toBe(true);
  });

  it('does not report a URL as a comment', () => {
    const comments = extractComments('const u = "https://example.com";', 'ts');
    expect(comments).toHaveLength(0);
  });

  it('returns comments in line order', () => {
    const src = '// a\nconst x = 1;\n// b\nconst y = 2;\n// c\n';
    const lines = extractComments(src, 'ts').map((c) => c.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('finds python comments', () => {
    const comments = extractComments('x = 1  # explains x\n', 'py');
    expect(comments[0]?.text).toBe('explains x');
  });
});

describe('line helpers', () => {
  it('computes a line number from an offset', () => {
    const src = 'a\nbb\nccc\n';
    expect(lineOfOffset(src, 0)).toBe(1);
    expect(lineOfOffset(src, 2)).toBe(2);
    expect(lineOfOffset(src, 5)).toBe(3);
  });

  it('returns trimmed line text', () => {
    expect(lineText('a\n  b  \nc', 2)).toBe('b');
  });

  it('returns an empty string for an out-of-range line', () => {
    expect(lineText('a', 99)).toBe('');
  });
});

describe('matchLines', () => {
  it('reports 1-based line numbers and trimmed text', () => {
    const src = 'const a = 1;\n  const b = 2;\nconst c = 3;\n';
    const hits = matchLines(src, /const\s+(\w+)/g);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
    expect(hits[1]?.text).toBe('const b = 2;');
  });

  it('adds the global flag when missing', () => {
    const hits = matchLines('foo\nfoo\n', /foo/);
    expect(hits).toHaveLength(2);
  });

  it('does not loop forever on a zero-width match', () => {
    const hits = matchLines('abc', /x*/g);
    expect(Array.isArray(hits)).toBe(true);
  });

  it('handles no matches', () => {
    expect(matchLines('abc', /zzz/g)).toHaveLength(0);
  });
});

describe('matchAll', () => {
  it('maps whole-text matches back to lines', () => {
    const src = 'one\ntwo\nthree\n';
    const hits = matchAll(src, /three/g);
    expect(hits[0]?.line).toBe(3);
    expect(hits[0]?.text).toBe('three');
  });

  it('finds multiple matches per line', () => {
    const hits = matchAll('a a a', /a/g);
    expect(hits).toHaveLength(3);
  });
});

describe('SourceFile', () => {
  const file = new SourceFile(
    'src/app.ts',
    [
      'import express from "express";',
      '',
      '// rate limiting is handled by the platform',
      'const app = express();',
      'app.get("/health", (_req, res) => res.json({ ok: true }));',
      '',
      'export default app;',
    ].join('\n'),
  );

  it('exposes content, lines and language', () => {
    expect(file.path).toBe('src/app.ts');
    expect(file.language).toBe('ts');
    expect(file.lineCount).toBe(7);
  });

  it('trims a line on request', () => {
    expect(file.line(3)).toBe('// rate limiting is handled by the platform');
    expect(file.line(99)).toBe('');
  });

  it('strips comments from a line without losing code', () => {
    expect(file.lineNoComments(3)).toBe('');
    expect(file.lineNoComments(4)).toBe('const app = express();');
  });

  it('reports line numbers for patterns', () => {
    expect(file.match(/health/)[0]?.line).toBe(5);
  });

  it('matches against comment-free text when asked', () => {
    // "rate limiting" appears only in a comment, so it must not match here.
    expect(file.match(/rate limiting/)).toHaveLength(1);
    expect(file.matchNoComments(/rate limiting/)).toHaveLength(0);
  });

  it('detects a nearby explanatory comment', () => {
    expect(file.hasExplanatoryCommentNear(4, ['rate limiting'])).toBe(true);
    expect(file.hasExplanatoryCommentNear(4, ['cache'])).toBe(false);
  });

  it('respects a shipready suppression comment', () => {
    const suppressed = new SourceFile('a.ts', '// shipready-disable-next-line readiness/security/no-eval\nconst x = eval(y);');
    expect(suppressed.isSuppressed(2, 'readiness/security/no-eval')).toBe(true);
    expect(suppressed.isSuppressed(2, 'readiness/security/other')).toBe(false);
  });

  it('treats a bare disable comment as suppressing everything', () => {
    const suppressed = new SourceFile('a.ts', '// shipready-disable\nconst x = eval(y);');
    expect(suppressed.isSuppressed(2)).toBe(true);
  });

  it('locates an offset to a line and column', () => {
    const f = new SourceFile('a.ts', 'one\ntwo\nthree');
    expect(f.locate(0)).toEqual({ line: 1, column: 0 });
    expect(f.locate(4)).toEqual({ line: 2, column: 0 });
    expect(f.locate(9)).toEqual({ line: 3, column: 1 });
  });
});