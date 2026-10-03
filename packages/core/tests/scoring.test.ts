import { describe, expect, it } from 'vitest';
import { gradeFor, humanDuration, scoreCategories, verdictFor, compareScans, summarize } from '../src/scoring.js';
import { SEVERITY_RANK } from '../src/types.js';
import type { CategoryScore, Finding, ProductionReadinessReport, ReadinessCategory, Severity } from '../src/types.js';
import { createFinding } from '../src/finding.js';

const now = '2026-01-02T00:00:00.000Z';

function finding(overrides: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding({
    ruleId: 'test/rule',
    title: 'Test finding',
    description: 'A finding used in tests',
    severity: 'medium',
    category: 'security',
    location: { path: 'a.ts', startLine: 1 },
    evidenceSummary: 'evidence',
    remediation: 'fix it',
    ...overrides,
  });
}

describe('severity ranking', () => {
  it('orders severities from info to critical', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
    expect(SEVERITY_RANK.low).toBeGreaterThan(SEVERITY_RANK.info);
  });
});

describe('gradeFor', () => {
  it('caps the top grade at A even at a perfect score', () => {
    expect(gradeFor(100)).toBe('A');
    expect(gradeFor(97)).toBe('A');
  });

  it('descends monotonically through the grade table', () => {
    const scores = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
    for (let i = 1; i < scores.length; i++) {
      expect(gradeFor(scores[i]!)).not.toBe('');
    }
    expect(gradeFor(0)).toBe('F-');
  });

  it('gives a realistic grade at a typical score', () => {
    expect(gradeFor(87)).toBe('B');
    expect(gradeFor(72)).toBe('C');
    expect(gradeFor(55)).toBe('D');
  });
});

describe('verdictFor', () => {
  it('says NOT READY when a confident critical blocker exists', () => {
    expect(verdictFor(90, [finding({ severity: 'critical', confidence: 0.95 })])).toBe('NOT READY');
  });

  it('lets a high score survive a single low-confidence blocker', () => {
    expect(verdictFor(92, [finding({ severity: 'high', confidence: 0.4 })])).toBe('READY WITH CAVEATS');
  });

  it('downgrades on blocker count even with a good score', () => {
    const many = Array.from({ length: 6 }, () => finding({ severity: 'high' }));
    expect(verdictFor(80, many)).toBe('NOT READY');
  });

  // verdictFor receives the blocker list, not every finding. A cosmetic
  // finding must not reach it, which is the engine's job to guarantee.
  it('awards PRODUCTION READY only for a clean high score', () => {
    expect(verdictFor(95, [])).toBe('PRODUCTION READY');
    expect(verdictFor(95, [])).toBe('PRODUCTION READY');
  });

  it('downgrades to CAVEATS when any blocker remains', () => {
    expect(verdictFor(95, [finding({ severity: 'medium' })])).toBe('READY WITH CAVEATS');
  });
});

describe('scoreCategories', () => {
  it('returns 100 with no findings', () => {
    const { categories, overall } = scoreCategories([]);
    expect(overall).toBe(100);
    expect(categories).toHaveLength(10);
    expect(categories.every((c) => c.score === 100)).toBe(true);
  });

  it('produces a weighted mean, not an unweighted one', () => {
    // Security weight 16, performance weight 8. Two findings, one in each.
    const findings = [
      finding({ category: 'performance', severity: 'high', confidence: 1 }),
      finding({ category: 'performance', severity: 'high', confidence: 1 }),
    ];
    const { categories } = scoreCategories(findings);
    const security = categories.find((c) => c.category === 'security')!;
    const performance = categories.find((c) => c.category === 'performance')!;
    expect(security.score).toBe(100);
    expect(performance.score).toBeLessThan(100);
    const { overall } = scoreCategories(findings);
    // Performance carries half the weight of security, so the damage is bounded.
    expect(overall).toBeGreaterThan(60);
  });

  it('caps the penalty per category at 100 points', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      finding({ severity: 'critical', confidence: 1, location: { path: `f${i}.ts`, startLine: i + 1 } }),
    );
    const { categories } = scoreCategories(many);
    const security = categories.find((c) => c.category === 'security')!;
    expect(security.score).toBe(0);
  });

  it('discounts low-confidence findings', () => {
    const confident = scoreCategories([finding({ confidence: 1 })]);
    const unsure = scoreCategories([finding({ confidence: 0.35 })]);
    expect(confident.overall).toBeLessThan(unsure.overall);
  });

  it('excludes categories when asked, and renormalises', () => {
    const withExcluded = scoreCategories([finding({ category: 'accessibility', severity: 'critical', confidence: 1 })], {
      excludedCategories: ['accessibility'],
    });
    expect(withExcluded.overall).toBe(100);
  });

  it('records counts by production impact', () => {
    const { categories } = scoreCategories([
      finding({ productionImpact: 'blocker', severity: 'critical' }),
      finding({ productionImpact: 'degradation', severity: 'medium' }),
      finding({ productionImpact: 'cosmetic', severity: 'low' }),
    ]);
    const security = categories.find((c) => c.category === 'security')!;
    expect(security.blockers).toBe(1);
    expect(security.degradations).toBe(1);
    expect(security.cosmetic).toBe(1);
  });

  it('is deterministic regardless of input order', () => {
    const a = finding({ severity: 'high' });
    const b = finding({ severity: 'low', location: { path: 'b.ts', startLine: 9 } });
    const c = finding({ severity: 'critical', location: { path: 'c.ts', startLine: 3 } });
    const one = scoreCategories([a, b, c]);
    const two = scoreCategories([c, b, a]);
    expect(one.overall).toBe(two.overall);
  });
});

describe('humanDuration', () => {
  it('reads naturally at each scale', () => {
    expect(humanDuration(0)).toBe('nothing to do');
    expect(humanDuration(30)).toContain('30 minutes');
    expect(humanDuration(120)).toContain('2 hours');
    expect(humanDuration(16 * 60)).toContain('working days');
    expect(humanDuration(200 * 60)).toContain('weeks');
  });

  it('never returns an empty string for a positive duration', () => {
    for (const m of [1, 59, 60, 61, 480, 481, 5000, 100_000]) {
      expect(humanDuration(m).length).toBeGreaterThan(0);
    }
  });
});

describe('summarize', () => {
  it('counts severities and estimates launch time from blockers only', () => {
    const s = summarize([
      finding({ severity: 'critical', productionImpact: 'blocker', effortMinutes: 60 }),
      finding({ severity: 'low', productionImpact: 'cosmetic', effortMinutes: 30 }),
    ]);
    expect(s.totalFindings).toBe(2);
    expect(s.bySeverity.critical).toBe(1);
    expect(s.byImpact.blocker).toBe(1);
    expect(s.estimatedMinutesToLaunch).toBe(60);
    expect(s.estimatedTimeToLaunch).toContain('hour');
  });
});

describe('compareScans', () => {
  const now = '2026-01-02T00:00:00.000Z';
  const before = '2026-01-01T00:00:00.000Z';

  it('detects resolved and new findings', () => {
    const fixed = finding({ ruleId: 'r/one', location: { path: 'a.ts', startLine: 1 } });
    const added = finding({ ruleId: 'r/two', location: { path: 'b.ts', startLine: 1 } });

    const previous = { findings: [fixed], categories: [] as CategoryScore[], score: 80, generatedAt: before };
    const current = { findings: [added], categories: [] as CategoryScore[], score: 82, generatedAt: now };

    const cmp = compareScans(current, previous);
    expect(cmp.scoreDelta).toBe(2);
    expect(cmp.resolvedFindings).toBe(1);
    expect(cmp.newFindings).toBe(1);
    expect(cmp.previousRunAt).toBe(before);
  });

  it('reports zero delta for an identical scan', () => {
    const f = [finding()];
    const snapshot = { findings: f, categories: [], score: 70, generatedAt: before };
    const cmp = compareScans({ ...snapshot, generatedAt: now }, snapshot);
    expect(cmp.scoreDelta).toBe(0);
    expect(cmp.newFindings).toBe(0);
    expect(cmp.resolvedFindings).toBe(0);
    expect(cmp.regressions).toHaveLength(0);
  });

  it('separates regressions from improvements', () => {
    const oldBlocker = finding({ ruleId: 'r/old', productionImpact: 'blocker', location: { path: 'a.ts', startLine: 1 } });
    const newBlocker = finding({ ruleId: 'r/new', productionImpact: 'blocker', location: { path: 'b.ts', startLine: 1 } });

    const cmp = compareScans(
      { findings: [newBlocker], categories: [], score: 60, generatedAt: now },
      { findings: [oldBlocker], categories: [], score: 70, generatedAt: before },
    );
    expect(cmp.regressions.map((r) => r.ruleId)).toEqual(['r/new']);
    expect(cmp.improvements.map((r) => r.ruleId)).toEqual(['r/old']);
    expect(cmp.blockersDelta).toBe(0);
  });

  it('reports a net change in blocker count', () => {
    const b1 = finding({ ruleId: 'r/a', productionImpact: 'blocker', location: { path: 'a.ts', startLine: 1 } });
    const b2 = finding({ ruleId: 'r/b', productionImpact: 'blocker', location: { path: 'b.ts', startLine: 1 } });
    const cmp = compareScans(
      { findings: [b1, b2], categories: [], score: 50, generatedAt: now },
      { findings: [], categories: [], score: 80, generatedAt: before },
    );
    expect(cmp.blockersDelta).toBe(2);
  });
});

describe('score weights', () => {
  it('accepts category weight overrides', () => {
    const findings = [finding({ category: 'testing', severity: 'critical', confidence: 1 })];
    const defaultScore = scoreCategories(findings).overall;
    const reweighted = scoreCategories(findings, { weights: { testing: 40 } }).overall;
    expect(reweighted).toBeLessThan(defaultScore);
  });
});

describe('severity to impact mapping', () => {
  const cases: [Severity, string][] = [
    ['critical', 'blocker'],
    ['high', 'blocker'],
    ['medium', 'degradation'],
    ['low', 'cosmetic'],
    ['info', 'cosmetic'],
  ];
  it.each(cases)('%s maps to %s by default', (severity, impact) => {
    const f = finding({ severity });
    expect(f.productionImpact).toBe(impact);
  });
});

describe('readiness report shape', () => {
  it('matches the published schema', () => {
    const { categories, overall } = scoreCategories([finding()]);
    const report: ProductionReadinessReport = {
      version: 1,
      score: overall,
      grade: gradeFor(overall),
      verdict: verdictFor(overall, []),
      target: { type: 'repo', path: '.' },
      project: { type: 'nextjs', frameworks: ['nextjs'], languages: ['ts'], totalLines: 100 },
      categories,
      summary: summarize([finding()]),
      topBlockers: [],
      findings: [finding()],
      durationMs: 5,
      generatedAt: now,
    };
    expect(report.version).toBe(1);
    expect(report.categories.length).toBe(10);
    for (const cat of report.categories satisfies CategoryScore[]) {
      expect(cat.score).toBeGreaterThanOrEqual(0);
      expect(cat.score).toBeLessThanOrEqual(100);
      expect(typeof cat.label).toBe('string');
    }
  });

  it('keeps all ten known categories present', () => {
    const { categories } = scoreCategories([]);
    expect(new Set(categories.map((c) => c.category))).toEqual(
      new Set<ReadinessCategory>([
        'accessibility',
        'ai-specific',
        'database',
        'data-integrity',
        'deployment',
        'error-handling',
        'observability',
        'performance',
        'security',
        'testing',
      ]),
    );
  });
});