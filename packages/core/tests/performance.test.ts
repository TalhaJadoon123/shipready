import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/source.js';

/**
 * Scan cost must stay linear in file length.
 *
 * `lineNoComments` used to re-split the whole file on every call, and rules call
 * it once per line inside loops that also iterate lines. That made scanning
 * quadratic in file size: an 8,000-line file took 61 seconds, and the cost per
 * line climbed as files grew (2.4ms/line at 500 lines, 7.6ms/line at 8,000).
 *
 * These tests pin the linear behaviour rather than a wall-clock number, since
 * absolute timings are machine-dependent. Reading every line repeatedly is the
 * access pattern that was quadratic; the ratio between a small and a large file
 * is what matters.
 */

/** Code shaped like the fixtures: many lines, each needing a masked read. */
function longFile(lines: number): string {
  const out: string[] = ['export function handler(req: Request) {'];
  for (let i = 0; i < lines; i++) {
    out.push(
      `  // step ${i}: a comment that must be blanked before matching`,
      `  const value${i} = await prisma.item.findUnique({ where: { id: ${i} } });`,
      `  if (!value${i}) { throw new Error("missing ${i}"); }`,
    );
  }
  out.push('}');
  return out.join('\n');
}

/** Read every line the way a rule does, in a nested loop. */
function readEveryLineTwice(file: SourceFile): number {
  let n = 0;
  const count = file.lineCount;
  for (let i = 1; i <= count; i++) {
    n += file.line(i).length;
    n += file.lineNoComments(i).length;
  }
  return n;
}

describe('line access is not quadratic', () => {
  it('reads every masked line correctly', () => {
    const file = new SourceFile('src/a.ts', 'const a = 1; // note\nconst b = 2;\n');
    expect(file.lineNoComments(1)).toBe('const a = 1;');
    // The comment is blanked but the line is not removed, so line numbers hold.
    expect(file.lineNoComments(2)).toBe('const b = 2;');
    expect(file.lineNoComments(99)).toBe('');
  });

  it('scales sub-quadratically with file length', () => {
    const small = new SourceFile('src/small.ts', longFile(500));
    const large = new SourceFile('src/large.ts', longFile(4000));

    // Warm up and take the best of several runs, so the measurement reflects the
    // code rather than JIT compilation and first-touch allocation.
    const time = (f: SourceFile): number => {
      readEveryLineTwice(f);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        readEveryLineTwice(f);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    const smallMs = time(small);
    const largeMs = time(large);

    // 8x the lines. Linear would be ~8x the time; quadratic would be ~64x.
    // A generous bound still catches a reintroduced re-split, which measured
    // around 64x here before the fix.
    const ratio = largeMs / smallMs;
    expect(
      ratio,
      `8x the lines took ${ratio.toFixed(1)}x the time (linear ~8x, quadratic ~64x)`,
    ).toBeLessThan(24);
  }, 30_000);

  it('returns a stable lineNoComments array across repeated calls', () => {
    const file = new SourceFile('src/a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    // The first call populates the cache; the rest must agree with it.
    const first = file.lineNoComments(2);
    expect(file.lineNoComments(2)).toBe(first);
    expect(file.lineNoComments(1)).toBe('const a = 1;');
    expect(file.lineNoComments(3)).toBe('const c = 3;');
  });
});

describe('comment lookup is indexed by line', () => {
  const commented: string[] = ['export function f() {'];
  for (let i = 0; i < 300; i++) {
    // Every line carries a comment, which is the worst case for a linear scan.
    commented.push(`  const v${i} = ${i}; // deliberately batched in one call`);
    commented.push(`  use(v${i});`);
  }
  commented.push('}');

  it('finds a comment on its own line, and on the lines just above it', () => {
    const file = new SourceFile('src/a.ts', commented.join('\n'));
    // Line 2 carries the comment.
    expect(file.hasExplanatoryCommentNear(2, ['deliberately'])).toBe(true);
    // Line 3 does not, but the default lookback of 2 lines reaches line 2, so it
    // still matches. That is the intended behaviour: the comment explaining
    // `const v0` also explains the `use(v0)` on the next line.
    expect(file.hasExplanatoryCommentNear(3, ['deliberately'])).toBe(true);
    // A different needle is not found on either line.
    expect(file.hasExplanatoryCommentNear(3, ['unrelated-needle'])).toBe(false);
    // With no lookback, line 3 sees nothing of its own.
    expect(file.hasExplanatoryCommentNear(3, ['deliberately'], 1)).toBe(false);
  });

  it('scales when every line has a comment', () => {
    const small = new SourceFile('src/s.ts', commented.slice(0, 200).join('\n'));
    const large = new SourceFile('src/l.ts', commented.join('\n'));

    const ask = (f: SourceFile) => {
      for (let i = 1; i <= f.lineCount; i++) f.hasExplanatoryCommentNear(i, ['deliberately']);
    };

    // Warm up first, and run each measurement several times taking the best.
    //
    // Without this the ratio is meaningless: the smaller file finishes in about
    // a millisecond, so the first call is dominated by JIT compilation and lazy
    // allocation rather than by the code under test. That produced a 56x
    // reading for a 3x input and a flake, which is worse than no test at all --
    // it teaches you to ignore the suite.
    const time = (f: SourceFile): number => {
      ask(f);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        ask(f);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    const smallMs = time(small);
    const largeMs = time(large);

    // Both files carry a comment on roughly every other line, so this is the
    // case a linear scan over all comments would make quadratic. Linear is 3x;
    // quadratic is 9x. 6x separates the two with room for a noisy machine.
    const ratio = largeMs / smallMs;
    expect(ratio, `3x the lines took ${ratio.toFixed(1)}x the time`).toBeLessThan(6);
  }, 30_000);

  it('still honours suppression comments', () => {
    const file = new SourceFile(
      'src/a.ts',
      ['// shipready-disable-next-line readiness/x/y', 'const danger = 1;', 'const other = 2;'].join('\n'),
    );
    expect(file.isSuppressed(2, 'readiness/x/y')).toBe(true);
    expect(file.isSuppressed(3, 'readiness/x/y')).toBe(false);
  });
});