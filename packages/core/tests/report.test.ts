import { describe, expect, it } from 'vitest';
import {
  formatConsole,
  formatGithubComment,
  formatGithubSummary,
  formatHtml,
  formatJson,
  formatMarkdown,
  formatReport,
  formatSarif,
  gradeFor,
  parseSarif,
  toScanSummary,
  verdictFor,
} from '../src/index.js';
import { scoreCategories, summarize } from '../src/scoring.js';
import { topBlockers } from '../src/scoring.js';
import { createFinding } from '../src/finding.js';
import { SEVERITY_ORDER, type Finding, type ProductionReadinessReport } from '../src/types.js';

function finding(over: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding({
    ruleId: 'readiness/security/no-rate-limiting',
    title: 'No rate limiting on API endpoints',
    description: 'API routes are reachable with no rate limit, which lets anyone script requests against them.',
    severity: 'critical',
    category: 'security',
    confidence: 0.9,
    productionImpact: 'blocker',
    location: { path: 'src/app.ts', startLine: 12, snippet: 'app.get("/x", handler);' },
    evidenceSummary: 'Express with 4 API routes and no rate-limiting middleware',
    remediation: 'Add express-rate-limit as app-level middleware.',
    compliance: [
      { framework: 'owasp-top-10', article: 'A07:2021', requirement: 'Identification and Authentication Failures' },
      { framework: 'gdpr', article: 'Article 32', requirement: 'Security of processing' },
    ],
    tags: ['abuse', 'launch-blocker'],
    cwe: 'CWE-770',
    owasp: 'A07:2021',
    fixable: true,
    effortMinutes: 60,
    references: ['https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/'],
    ...over,
  });
}

function reportWith(findings: Finding[]): ProductionReadinessReport {
  const { categories, overall } = scoreCategories(findings);
  return {
    version: 1,
    score: overall,
    grade: gradeFor(overall),
    verdict: verdictFor(overall, findings.filter((f) => f.productionImpact === 'blocker')),
    target: { type: 'repo', path: '.' },
    project: { type: 'express', frameworks: ['express'], languages: ['ts'], totalLines: 1234 },
    categories,
    summary: summarize(findings),
    topBlockers: topBlockers(findings, 5),
    findings,
    durationMs: 42,
    generatedAt: '2026-01-02T03:04:05.000Z',
  };
}

const SAMPLE = reportWith([
  finding(),
  finding({
    ruleId: 'readiness/observability/no-health-check',
    title: 'No health check endpoint',
    severity: 'high',
    productionImpact: 'blocker',
    category: 'observability',
    location: { path: 'src/server.ts', startLine: 1 },
    evidenceSummary: 'Express service with no /health endpoint',
    compliance: [{ framework: 'soc2', article: 'CC7.2', requirement: 'Monitoring for anomalies' }],
    effortMinutes: 30,
  }),
  finding({
    ruleId: 'readiness/accessibility/missing-alt-text',
    title: 'Image with no alt text',
    severity: 'medium',
    productionImpact: 'degradation',
    category: 'accessibility',
    location: { path: 'app/page.tsx', startLine: 4 },
    evidenceSummary: '<img> with no alt attribute',
    compliance: [],
    effortMinutes: 10,
  }),
  finding({
    ruleId: 'readiness/deployment/no-staging-environment',
    title: 'No separate staging environment configuration',
    severity: 'low',
    productionImpact: 'cosmetic',
    category: 'deployment',
    location: { path: 'package.json', startLine: 1 },
    evidenceSummary: 'no staging configuration found',
    compliance: [{ framework: 'iso-27001', article: 'A.8.25', requirement: 'Secure development life cycle' }],
    effortMinutes: 90,
  }),
]);

describe('console report', () => {
  it('leads with the verdict and the score', () => {
    const out = formatConsole(SAMPLE);
    expect(out).toMatch(SAMPLE.verdict);
    expect(out).toContain(String(SAMPLE.score));
    expect(out).toMatch(new RegExp(`${SAMPLE.score}/100`));
  });

  it('lists blockers with a path, a line and a remediation', () => {
    const out = formatConsole(SAMPLE);
    expect(out).toContain('Fix before launch');
    expect(out).toContain('src/app.ts:12');
    expect(out).toContain('Add express-rate-limit');
  });

  it('shows every category with its score', () => {
    const out = formatConsole(SAMPLE);
    for (const category of SAMPLE.categories) {
      expect(out, category.label).toContain(category.label);
    }
  });

  it('counts findings by severity', () => {
    const out = formatConsole(SAMPLE);
    expect(out).toContain('4 total');
    expect(out).toContain('critical');
  });

  it('mentions the auto-fix count', () => {
    expect(formatConsole(SAMPLE)).toContain('auto-fixed');
  });

  it('omits cosmetic findings unless verbose', () => {
    const noisy = reportWith(
      Array.from({ length: 30 }, (_, i) =>
        finding({
                ruleId: `readiness/deployment/no-rollback-plan-${i}`,
          title: `Rollback note ${i}`,
          severity: 'low',
          productionImpact: 'cosmetic',
          category: 'deployment',
          location: { path: `README-${i}.md`, startLine: 1 },
          evidenceSummary: `no rollback note ${i}`,
          compliance: [],
          effortMinutes: 45,
        }),
      ),
    );
    expect(formatConsole(noisy)).toContain('more. Use --verbose');
    expect(formatConsole(noisy, { verbose: true })).toContain('Rollback note 29');
  });

  it('reports the compliance frameworks involved', () => {
    const out = formatConsole(SAMPLE);
    expect(out).toContain('Compliance exposure');
    expect(out).toContain('owasp-top-10');
  });

  it('says so plainly when there are no blockers', () => {
    const clean = reportWith([
      finding({
        ruleId: 'readiness/accessibility/missing-alt-text',
        title: 'Image with no alt text',
        severity: 'medium',
        productionImpact: 'degradation',
        category: 'accessibility',
        compliance: [],
      }),
    ]);
    expect(formatConsole(clean)).toContain('No launch blockers');
  });

  it('renders comparison data when present', () => {
    const withComparison: ProductionReadinessReport = {
      ...SAMPLE,
      comparison: {
        previousScore: 40,
        scoreDelta: 8,
        newFindings: 2,
        resolvedFindings: 5,
        blockersDelta: -1,
        categoryDeltas: [{ category: 'security', label: 'Security', from: 30, to: 64, delta: 34 }],
        regressions: [],
        improvements: [],
      },
    };
    const out = formatConsole(withComparison);
    expect(out).toContain('Since last scan');
    expect(out).toContain('5 fixed, 2 new');
  });

  it('produces no ANSI codes when colour is disabled', async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    const { setColour } = await import('../src/report/console.js');
    try {
      setColour(false);
      expect(formatConsole(SAMPLE)).not.toMatch(/\[[0-9;]*m/);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});

describe('markdown report', () => {
  it('produces a heading and a verdict line', () => {
    const md = formatMarkdown(SAMPLE);
    expect(md.startsWith('## Production Readiness Report')).toBe(true);
    expect(md).toContain(`**${SAMPLE.verdict}**`);
  });

  it('renders a summary table', () => {
    const md = formatMarkdown(SAMPLE);
    expect(md).toContain('| **Score** |');
    expect(md).toContain('| **Time to launch** |');
  });

  it('lists blockers with remediation', () => {
    const md = formatMarkdown(SAMPLE);
    expect(md).toContain('Fix before launch');
    expect(md).toContain('Add express-rate-limit');
  });

  it('renders a category table with all ten categories', () => {
    const md = formatMarkdown(SAMPLE);
    expect(md).toContain('### Category scores');
    for (const category of SAMPLE.categories) expect(md, category.label).toContain(category.label);
  });

  it('escapes pipes so the table cannot be broken', () => {
    const md = formatMarkdown(
      reportWith([finding({ evidenceSummary: 'matches `a | b | c` in the source' })]),
    );
    expect(md).toContain('\\|');
  });

  it('gives every finding an anchor, including omitted ones', () => {
    const md = formatMarkdown(SAMPLE);
    for (const f of SAMPLE.findings) expect(md, f.ruleId).toContain(`id="${f.id}"`);
  });

  it('anchors findings even when the table omits them', () => {
    const md = formatMarkdown(SAMPLE, { full: false });
    const cosmetic = SAMPLE.findings.find((f) => f.productionImpact === 'cosmetic')!;
    // The cosmetic finding is not in the table, but a link to it must resolve.
    expect(md).toContain(`id="${cosmetic.id}"`);
  });

  it('omits cosmetic findings unless full is requested', () => {
    expect(formatMarkdown(SAMPLE)).toContain('cosmetic omitted');
    expect(formatMarkdown(SAMPLE, { full: true })).not.toContain('cosmetic omitted');
  });

  it('renders the compliance table when mappings exist', () => {
    const md = formatMarkdown(SAMPLE);
    expect(md).toContain('### Compliance exposure');
    expect(md).toContain('A07:2021');
    expect(md).toContain('Art. 32');
  });

  it('can skip the compliance section', () => {
    expect(formatMarkdown(SAMPLE, { includeCompliance: false })).not.toContain('### Compliance exposure');
  });

  it('uses a custom title when given one', () => {
    expect(formatMarkdown(SAMPLE, { title: 'Readiness' })).toContain('## Readiness');
  });
});

describe('SARIF report', () => {
  const sarifText = formatSarif(SAMPLE);
  const sarif = parseSarif(sarifText);

  it('declares schema and version 2.1.0', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
  });

  it('names the tool', () => {
    expect(sarif.runs[0]!.tool.driver.name).toBe('ShipReady');
    expect(sarif.runs[0]!.tool.driver.version).toBeTruthy();
  });

  it('deduplicates rules and emits one result per finding', () => {
    expect(sarif.runs[0]!.tool.driver.rules.length).toBe(4);
    expect(sarif.runs[0]!.results.length).toBe(4);
  });

  it('maps severity to a SARIF level', () => {
    const critical = sarif.runs[0]!.results.find((r) => r.ruleId.includes('rate-limiting'))!;
    expect(critical.level).toBe('error');
    const low = sarif.runs[0]!.results.find((r) => r.ruleId.includes('staging'))!;
    expect(low.level).toBe('note');
  });

  it('sets security-severity only where GitHub will surface the alert', () => {
    const rules = sarif.runs[0]!.tool.driver.rules;
    const rateLimit = rules.find((r) => r.id.includes('rate-limiting'))!;
    expect(rateLimit.properties['security-severity']).toBe('9.0');
    const altText = rules.find((r) => r.id.includes('alt-text'))!;
    expect(altText.properties['security-severity']).toBeUndefined();
  });

  it('records precision from confidence', () => {
    const rule = sarif.runs[0]!.tool.driver.rules.find((r) => r.id.includes('rate-limiting'))!;
    expect(rule.properties.precision).toBe('high');
  });

  it('includes a partial fingerprint so results stay stable across runs', () => {
    const result = sarif.runs[0]!.results[0]!;
    expect(result.partialFingerprints?.shipreadyFindingId).toBeTruthy();
  });

  it('carries the location through', () => {
    const result = sarif.runs[0]!.results.find((r) => r.ruleId.includes('rate-limiting'))!;
    const location = result.locations[0]!.physicalLocation;
    expect(location.artifactLocation.uri).toBe('src/app.ts');
    expect(location.region.startLine).toBe(12);
    expect(location.region.snippet?.text).toBeTruthy();
  });

  it('serialises to valid JSON', () => {
    expect(() => JSON.parse(formatSarif(SAMPLE))).not.toThrow();
  });

  it('round-trips through parseSarif', () => {
    const parsed = parseSarif(formatSarif(SAMPLE));
    expect(parsed.runs[0]!.results.length).toBe(SAMPLE.findings.length);
  });
});

describe('GitHub comment', () => {
  const comment = formatGithubComment(SAMPLE);

  it('leads with the verdict', () => {
    expect(comment.startsWith('## ')).toBe(true);
    expect(comment).toContain(SAMPLE.verdict);
  });

  it('shows the score', () => {
    expect(comment).toContain(`**Score ${SAMPLE.score}/100**`);
  });

  /** The blocker list only, before the embedded full report. */
function blockerList(md: string): string[] {
  const start = md.indexOf('### Top ');
  const end = md.indexOf('<details>');
  if (start < 0) return [];
  return md.slice(start, end < 0 ? undefined : end).split('\n').filter((l) => /^\d\. \*\*/.test(l));
}

it('limits blockers to three by default', () => {
    expect(blockerList(comment).length).toBeLessThanOrEqual(3);
  });

  it('honours maxBlockers', () => {
    expect(blockerList(formatGithubComment(SAMPLE, { maxBlockers: 1 })).length).toBe(1);
  });

  it('collapses the full report into a details block', () => {
    expect(comment).toContain('<details>');
    expect(comment).toContain('</details>');
  });

  it('does not repeat blank lines excessively', () => {
    expect(comment).not.toMatch(/\n{4,}/);
  });

  it('includes the totals line', () => {
    expect(comment).toMatch(/auto-fixable/);
  });
});

describe('one-line summary', () => {
  it('joins the key numbers', () => {
    const line = formatGithubSummary(SAMPLE);
    expect(line).toContain(`Score ${SAMPLE.score}/100`);
    expect(line).toContain(SAMPLE.verdict);
    expect(line).not.toContain('\n');
  });
});

describe('HTML report', () => {
  const html = formatHtml(SAMPLE);

  it('is a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<title>');
  });

  it('embeds no external resources', () => {
    // A report must open from a download directory with no network.
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it('shows the verdict and score', () => {
    expect(html).toContain(SAMPLE.verdict);
    expect(html).toContain(String(SAMPLE.score));
  });

  it('renders the category radar without a charting library', () => {
    expect(html).toContain('<polygon');
    expect(html).not.toContain('chart.js');
  });

  it('renders a severity bar chart', () => {
    expect(html).toContain('Findings by severity');
  });

  it('lists every finding', () => {
    for (const f of SAMPLE.findings) {
      expect(html, f.title).toContain(escapeHtml(f.title));
    }
  });

  it('escapes HTML in user-derived text', () => {
    const nasty = reportWith([
      finding({ title: '<script>alert(1)</script>', evidenceSummary: '<img src=x onerror=alert(1)>' }),
    ]);
    const out = formatHtml(nasty);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('supports a custom title', () => {
    expect(formatHtml(SAMPLE, { title: 'My Report' })).toContain('<title>My Report</title>');
  });
});

describe('JSON report', () => {
  it('round-trips the whole report', () => {
    const parsed = JSON.parse(formatJson(SAMPLE)) as ProductionReadinessReport;
    expect(parsed.score).toBe(SAMPLE.score);
    expect(parsed.findings).toHaveLength(SAMPLE.findings.length);
    expect(parsed.version).toBe(1);
  });

  it('omits the internal config from the target', () => {
    const withConfig = reportWith([]);
    withConfig.target = { type: 'repo', path: '.', config: { offline: true } };
    expect(JSON.parse(formatJson(withConfig)).target.config).toBeUndefined();
  });

  it('flattens into a dashboard summary', () => {
    const summary = toScanSummary(SAMPLE);
    expect(summary.score).toBe(SAMPLE.score);
    expect(Object.keys(summary.categories)).toHaveLength(10);
    expect(summary.categories.security?.score).toBeTypeOf('number');
    expect(summary.topBlockers[0]?.ruleId).toBe(SAMPLE.topBlockers[0]?.ruleId);
  });
});

describe('formatReport dispatch', () => {
  it('produces each format', () => {
    expect(formatReport(SAMPLE, 'json')).toContain('"score"');
    expect(formatReport(SAMPLE, 'markdown')).toContain('## Production Readiness Report');
    expect(formatReport(SAMPLE, 'html')).toContain('<!doctype html>');
    expect(formatReport(SAMPLE, 'sarif')).toContain('sarif-schema-2.1.0');
    expect(formatReport(SAMPLE, 'github')).toContain('## ');
    expect(formatReport(SAMPLE, 'summary')).not.toContain('\n');
    expect(formatReport(SAMPLE, 'console')).toContain('ShipReady');
  });

  it('accepts md as an alias for markdown', () => {
    expect(formatReport(SAMPLE, 'md')).toBe(formatReport(SAMPLE, 'markdown'));
  });

  it('throws a helpful error for an unknown format', () => {
    expect(() => formatReport(SAMPLE, 'pdf' as never)).toThrow(/Unknown report format/);
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

describe('severity ordering in reports', () => {
  it('lists findings worst first', () => {
    const orders = SAMPLE.findings.map((f) => f.severity);
    const ranks = SEVERITY_ORDER.map((s) => orders.indexOf(s)).filter((i) => i >= 0);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
