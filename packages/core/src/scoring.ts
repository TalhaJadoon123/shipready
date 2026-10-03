import { toSummary } from './finding.js';
import {
  CATEGORY_LABELS,
  DEFAULT_CATEGORY_WEIGHTS,
  SEVERITY_RANK,
  type Blocker,
  type CategoryScore,
  type Finding,
  type ProductionImpact,
  type ReadinessCategory,
  type ScanComparison,
  type Severity,
  type Verdict,
} from './types.js';

/**
 * Category scoring.
 *
 * Each finding costs points, and the cost falls off with confidence so a
 * 30%-confidence guess barely dents a category while a 95%-confidence
 * observation hurts. Points are capped per category so that a repo with fifty
 * medium findings and a repo with one critical finding in the same category do
 * not end up at wildly different scores: the second one is the real problem.
 */
const SEVERITY_COST: Record<Severity, number> = {
  critical: 34,
  high: 20,
  medium: 10,
  low: 4,
  info: 1,
};

/** Confidence multipliers: a hint is worth much less than a proof. */
const CONFIDENCE_FLOOR = 0.35;

function costOf(finding: Finding): number {
  const base = SEVERITY_COST[finding.severity];
  const confidence = Math.max(CONFIDENCE_FLOOR, finding.confidence);
  return base * confidence;
}

export interface ScoreOptions {
  weights?: Partial<Record<ReadinessCategory, number>>;
  /** Categories with no applicable rules for this project. */
  excludedCategories?: ReadinessCategory[];
}

export interface CategoryScoreResult {
  categories: CategoryScore[];
  /** 0-100, weighted mean of applicable categories. */
  overall: number;
}

export function scoreCategories(
  findings: readonly Finding[],
  options: ScoreOptions = {},
): CategoryScoreResult {
  const weights = { ...DEFAULT_CATEGORY_WEIGHTS, ...(options.weights ?? {}) };
  const excluded = new Set(options.excludedCategories ?? []);

  const byCategory = new Map<ReadinessCategory, Finding[]>();
  for (const f of findings) {
    const arr = byCategory.get(f.category);
    if (arr) arr.push(f);
    else byCategory.set(f.category, [f]);
  }

  const categories: CategoryScore[] = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const category of Object.keys(CATEGORY_LABELS) as ReadinessCategory[]) {
    if (excluded.has(category)) continue;
    const list = (byCategory.get(category) ?? []).slice().sort(worseFirst);
    const weight = weights[category] ?? 0;

    // Cap the total penalty so one catastrophic category cannot zero the
    // whole project on its own: 100 points of deductions max out a category.
    const raw = list.reduce((sum, f) => sum + costOf(f), 0);
    const penalty = Math.min(100, raw);
    const score = Math.max(0, Math.round(100 - penalty));

    const blockers = list.filter((f) => f.productionImpact === 'blocker').length;
    const degradations = list.filter((f) => f.productionImpact === 'degradation').length;
    const cosmetic = list.filter((f) => f.productionImpact === 'cosmetic').length;

    categories.push({
      category,
      label: CATEGORY_LABELS[category],
      score,
      weight,
      findingCount: list.length,
      blockers,
      degradations,
      cosmetic,
      topIssues: list.slice(0, 5).map(toSummary),
    });

    weightedSum += score * weight;
    weightTotal += weight;
  }

  const overall = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  return { categories, overall: Math.max(0, Math.min(100, overall)) };
}

export function worseFirst(a: Finding, b: Finding): number {
  const impact = impactRank(b.productionImpact) - impactRank(a.productionImpact);
  if (impact !== 0) return impact;
  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  if (Math.abs(b.confidence - a.confidence) > 0.01) return b.confidence - a.confidence;
  if (b.effortMinutes !== a.effortMinutes) return a.effortMinutes - b.effortMinutes;
  return a.id.localeCompare(b.id);
}

function impactRank(impact: ProductionImpact): number {
  return impact === 'blocker' ? 3 : impact === 'degradation' ? 2 : 1;
}

/**
 * Letter grade. A+ is unreachable on purpose: 97+ means "we found nothing",
 * which almost always means the rules did not run, not that the software is
 * perfect. Making 100 require a human decision keeps the top grade meaningful.
 */
export function gradeFor(score: number): string {
  if (score >= 97) return 'A';
  if (score >= 93) return 'A-';
  if (score >= 90) return 'B+';
  if (score >= 85) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 75) return 'C+';
  if (score >= 70) return 'C';
  if (score >= 65) return 'C-';
  if (score >= 60) return 'D+';
  if (score >= 50) return 'D';
  if (score >= 40) return 'D-';
  if (score >= 30) return 'E';
  if (score >= 20) return 'F';
  return 'F-';
}

/**
 * Launch verdict. Deliberately not a pure function of the score: a repo with a
 * 72 and zero blockers is more launchable than a 72 with a live CORS wildcard
 * and hardcoded keys. The score sets the band, the blockers veto it.
 */
export function verdictFor(
  score: number,
  blockers: readonly Finding[],
): Verdict {
  const criticalBlockers = blockers.filter(
    (b) => b.severity === 'critical' && b.confidence >= 0.7,
  ).length;
  const total = blockers.length;

  if (criticalBlockers > 0 || total >= 6 || score < 45) return 'NOT READY';
  if (total >= 3 || score < 65) return 'NEEDS WORK';
  if (total > 0 || score < 85) return 'READY WITH CAVEATS';
  return 'PRODUCTION READY';
}

/** The top N blockers, worst first, deduped by rule so one bug is not five blockers. */
export function topBlockers(
  findings: readonly Finding[],
  limit = 5,
  autoFixFor?: (f: Finding) => Blocker['autoFix'],
): Blocker[] {
  const blockers = findings
    .filter((f) => f.productionImpact === 'blocker')
    .filter((f) => f.confidence >= 0.5)
    .sort(worseFirst);

  const seenRules = new Set<string>();
  const out: Blocker[] = [];
  for (const f of blockers) {
    if (seenRules.has(f.ruleId)) continue;
    seenRules.add(f.ruleId);
    const fix = autoFixFor?.(f);
    out.push({
      ...toSummary(f),
      rationale: `${f.title}. ${f.evidence.summary}`,
      remediation: f.remediation,
      ...(fix ? { autoFix: fix } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function summarize(findings: readonly Finding[]): {
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  byImpact: Record<ProductionImpact, number>;
  blockers: number;
  fixable: number;
  estimatedMinutesToLaunch: number;
  estimatedTimeToLaunch: string;
} {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byImpact: Record<ProductionImpact, number> = { blocker: 0, degradation: 0, cosmetic: 0 };
  let fixable = 0;
  let minutes = 0;

  for (const f of findings) {
    bySeverity[f.severity]++;
    byImpact[f.productionImpact]++;
    if (f.fixable) fixable++;
    if (f.productionImpact === 'blocker') minutes += f.effortMinutes;
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    byImpact,
    blockers: byImpact.blocker,
    fixable,
    estimatedMinutesToLaunch: minutes,
    estimatedTimeToLaunch: humanDuration(minutes),
  };
}

/** `390` -> `about 6.5 hours`. Rounding to real engineering units matters. */
export function humanDuration(minutes: number): string {
  if (minutes <= 0) return 'nothing to do';
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 8) return `about ${round1(hours)} hours`;
  const days = hours / 8;
  if (days < 10) return `about ${round1(days)} working days`;
  const weeks = days / 5;
  if (weeks < 12) return `about ${round1(weeks)} weeks`;
  const months = weeks / 4.33;
  return `about ${round1(months)} months`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Diff two completed reports. Powers `--compare`. */
export function compareScans(
  current: { findings: readonly Finding[]; categories: CategoryScore[]; score: number; generatedAt: string },
  previous: { findings: readonly Finding[]; categories: CategoryScore[]; score: number; generatedAt: string },
): ScanComparison {
  const prevById = new Map(previous.findings.map((f) => [f.id, f]));
  const currById = new Map(current.findings.map((f) => [f.id, f]));

  const newFindings = current.findings.filter((f) => !prevById.has(f.id));
  const resolvedFindings = previous.findings.filter((f) => !currById.has(f.id));

  const prevByRule = new Map<string, number>();
  for (const f of previous.findings) prevByRule.set(f.ruleId, (prevByRule.get(f.ruleId) ?? 0) + 1);
  const currByRule = new Map<string, number>();
  for (const f of current.findings) currByRule.set(f.ruleId, (currByRule.get(f.ruleId) ?? 0) + 1);

  const previousBlockerIds = new Set(
    previous.findings.filter((f) => f.productionImpact === 'blocker').map((f) => f.id),
  );
  const currentBlockerIds = new Set(
    current.findings.filter((f) => f.productionImpact === 'blocker').map((f) => f.id),
  );

  const regressions = current.findings
    .filter((f) => f.productionImpact === 'blocker' && !previousBlockerIds.has(f.id))
    .sort(worseFirst)
    .map(toBlockerBare);
  const improvements = previous.findings
    .filter((f) => f.productionImpact === 'blocker' && !currentBlockerIds.has(f.id))
    .sort(worseFirst)
    .map(toBlockerBare);

  const prevCategories = new Map(previous.categories.map((c) => [c.category, c]));
  const categoryDeltas = current.categories.map((c) => {
    const prev = prevCategories.get(c.category);
    const from = prev?.score ?? c.score;
    return {
      category: c.category,
      label: c.label,
      from,
      to: c.score,
      delta: c.score - from,
    };
  });

  return {
    previousScore: previous.score,
    scoreDelta: current.score - previous.score,
    newFindings: newFindings.length,
    resolvedFindings: resolvedFindings.length,
    previousRunAt: previous.generatedAt,
    blockersDelta: currentBlockerIds.size - previousBlockerIds.size,
    categoryDeltas,
    regressions,
    improvements,
  };
}

function toBlockerBare(f: Finding): Blocker {
  return {
    ...toSummary(f),
    rationale: `${f.title}. ${f.evidence.summary}`,
    remediation: f.remediation,
  };
}

