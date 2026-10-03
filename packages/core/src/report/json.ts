import type { ProductionReadinessReport } from '../types.js';

/**
 * JSON report.
 *
 * The whole report, pretty-printed, so it can be piped into `jq`, diffed in
 * CI, or posted to the dashboard. Stable field names and a version number are
 * part of the contract: the dashboard reads historical reports written by
 * older CLI versions.
 *
 * The scan config is stripped: it can carry internal rule paths and thresholds
 * that have no business in a report someone pastes into an issue.
 */
export function formatJson(report: ProductionReadinessReport): string {
  const sanitised: ProductionReadinessReport = {
    ...report,
    target: { ...report.target, config: undefined },
  };
  return JSON.stringify(sanitised, null, 2);
}

/**
 * JSON for dashboards and integrations.
 *
 * A flatter shape than the report: category scores as a plain object keyed by
 * category, findings reduced to the fields an API consumer actually uses. This
 * is what `POST /api/scan` returns.
 */
export interface ScanSummaryJson {
  score: number;
  grade: string;
  verdict: string;
  generatedAt: string;
  durationMs: number;
  project: ProductionReadinessReport['project'];
  categories: Record<string, { score: number; weight: number; findings: number; blockers: number }>;
  totals: ProductionReadinessReport['summary'];
  topBlockers: { ruleId: string; title: string; path: string; line: number; severity: string; impact: string; remediation: string }[];
  findingCount: number;
}

export function toScanSummary(report: ProductionReadinessReport): ScanSummaryJson {
  const categories: ScanSummaryJson['categories'] = {};
  for (const c of report.categories) {
    categories[c.category] = {
      score: c.score,
      weight: c.weight,
      findings: c.findingCount,
      blockers: c.blockers,
    };
  }
  return {
    score: report.score,
    grade: report.grade,
    verdict: report.verdict,
    generatedAt: report.generatedAt,
    durationMs: report.durationMs,
    project: report.project,
    categories,
    totals: report.summary,
    topBlockers: report.topBlockers.map((b) => ({
      ruleId: b.ruleId,
      title: b.title,
      path: b.path,
      line: b.line,
      severity: b.severity,
      impact: b.productionImpact,
      remediation: b.remediation,
    })),
    findingCount: report.findings.length,
  };
}