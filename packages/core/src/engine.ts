import { createScanContext } from './context.js';
import { DEFAULT_FIX_LIMIT, DEFAULT_SCAN_CONFIG } from './config.js';
import { planFixes, type FixContext } from './autofix/fixers.js';
import { internals } from './context.js';
import { dedupeFindings } from './finding.js';
import { PluginRegistry } from './registry.js';
import {
  compareScans,
  gradeFor,
  scoreCategories,
  summarize,
  topBlockers,
  verdictFor,
  worseFirst,
} from './scoring.js';
import {
  SEVERITY_RANK,
  type Finding,
  type ProductionReadinessReport,
  type ScanConfig,
  type ScanContext,
  type ScanTarget,
  type Scanner,
} from './types.js';

/** Callback used by `--fix` to turn a blocker into a concrete patch plan. */
export type AutoFixResolver = (finding: Finding) => BlockerFix | undefined;
export interface BlockerFix {
  ruleId: string;
  description: string;
  create: { path: string; content: string }[];
  modify: { path: string; edits: { find: string; replace: string; replaceAll?: boolean }[] }[];
  requiresReview: boolean;
}

export interface ScanOptions {
  registry?: PluginRegistry;
  config?: ScanConfig;
  /** Called for every scanner before it runs. Return false to skip it. */
  shouldRun?: (scanner: Scanner) => boolean;
  /** Called as findings stream in, for progress output. */
  onFinding?: (finding: Finding, index: number) => void;
  /** Called when a scanner throws. Scans must survive one bad rule. */
  onScannerError?: (scannerId: string, error: Error) => void;
  /** Supplies a previous report for `--compare`. */
  previousReport?: ProductionReadinessReport | null;
  resolveFix?: AutoFixResolver;
}

export interface ScanResult {
  report: ProductionReadinessReport;
  findings: Finding[];
  context: ScanContext;
}

/**
 * Run every registered scanner and stream findings as they are produced.
 *
 * Streaming is not cosmetic: on a large repo the first finding should appear
 * immediately so the CLI can print "scanning..." with real numbers, and CI can
 * fail fast on a hard blocker instead of waiting for the full pass.
 *
 * The generator's return value is the completed `ScanContext`, so a caller can
 * do `for await (...) {}` and then read `ctx.project` for its own output.
 */
export async function* streamFindings(
  target: ScanTarget,
  options: ScanOptions = {},
): AsyncGenerator<Finding, ScanContext, void> {
  const registry = options.registry ?? new PluginRegistry();
  const context = await createScanContext(target, registry);
  const config: ScanConfig = { ...DEFAULT_SCAN_CONFIG, ...(target.config ?? {}), ...(options.config ?? {}) };

  for (const scanner of registry.all()) {
    if (options.shouldRun && !options.shouldRun(scanner)) continue;
    if (shouldSkipByConfig(scanner, config)) continue;
    try {
      for await (const finding of scanner.scan(context)) {
        if (!passesFilters(finding, config)) continue;
        yield finding;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      context.warn(`Scanner "${scanner.id}" failed: ${err.message}`);
      options.onScannerError?.(scanner.id, err);
    }
  }

  return context;
}

/** Run a full scan and produce the Production Readiness Report. */
export async function runScan(target: ScanTarget, options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const registry = options.registry ?? new PluginRegistry();
  const context = await createScanContext(target, registry);

  const collected: Finding[] = [];
  let index = 0;
  for (const scanner of registry.all()) {
    if (options.shouldRun && !options.shouldRun(scanner)) continue;
    if (shouldSkipByConfig(scanner, config2(target, options))) continue;
    try {
      for await (const finding of scanner.scan(context)) {
        if (!passesFilters(finding, config2(target, options))) continue;
        collected.push(finding);
        options.onFinding?.(finding, index++);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      context.warn(`Scanner "${scanner.id}" failed: ${err.message}`);
      options.onScannerError?.(scanner.id, err);
    }
  }

  const findings = dedupeFindings(collected).sort(worseFirst);
  const report = buildReport(target, context, findings, started, options);
  return { report, findings, context };
}

function config2(target: ScanTarget, options: ScanOptions): ScanConfig {
  return { ...DEFAULT_SCAN_CONFIG, ...(target.config ?? {}), ...(options.config ?? {}) };
}

function shouldSkipByConfig(scanner: Scanner, config: ScanConfig): boolean {
  if (config.onlyRules?.length) {
    return !config.onlyRules.some(
      (r) => scanner.id === r || scanner.id.startsWith(`${r}/`) || scanner.id.endsWith(`/${r}`),
    );
  }
  if (config.disableRules?.includes(scanner.id)) return true;
  return false;
}

function passesFilters(finding: Finding, config: ScanConfig): boolean {
  const minConfidence = config.minConfidence ?? 0;
  if (finding.confidence < minConfidence) return false;
  if (config.minSeverity) {
    const minRank = SEVERITY_RANK[config.minSeverity];
    if (SEVERITY_RANK[finding.severity] < minRank) return false;
  }
  return true;
}

function buildReport(
  target: ScanTarget,
  context: ScanContext,
  findings: Finding[],
  started: number,
  options: ScanOptions,
): ProductionReadinessReport {
  const weights = options.config?.categoryWeights;
  const { categories, overall } = scoreCategories(findings, weights ? { weights } : {});
  const summary = summarize(findings);
  const blockers = findings.filter((f) => f.productionImpact === 'blocker');
  const verdict = verdictFor(overall, blockers);

  // Attach auto-fix plans to blockers so `--fix` and the dashboard know what
  // they can generate without a second pass.
  const fixes = planFixes(findings, fixContextFor(context), DEFAULT_FIX_LIMIT);
  const fixByRule = new Map<string, BlockerFix>();
  for (const fix of fixes.fixes) {
    if (fixByRule.has(fix.ruleId)) continue;
    fixByRule.set(fix.ruleId, {
      ruleId: fix.ruleId,
      description: fix.description,
      create: fixes.fixes
        .filter((f) => f.ruleId === fix.ruleId && f.kind === 'create')
        .map((f) => ({ path: f.path, content: f.content ?? '' })),
      modify: fixes.fixes
        .filter((f) => f.ruleId === fix.ruleId && f.kind !== 'create')
        .map((f) => ({ path: f.path, edits: [{ find: f.find ?? '', replace: f.replace ?? '' }] })),
      requiresReview: fix.requiresReview,
    });
  }

  const resolve =
    options.resolveFix ??
    ((f: Finding): BlockerFix | undefined => {
      const plan = fixByRule.get(f.ruleId);
      return plan;
    });

  const report: ProductionReadinessReport = {
    version: 1,
    score: overall,
    grade: gradeFor(overall),
    verdict,
    target: { ...target, config: undefined },
    project: {
      type: context.project.type,
      frameworks: context.project.frameworks,
      languages: context.project.languages,
      totalLines: context.project.totalLines,
    },
    categories,
    summary,
    topBlockers: topBlockers(findings, 5, resolve),
    findings,
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };

  if (options.previousReport) {
    report.comparison = compareScans(
      { findings, categories, score: overall, generatedAt: report.generatedAt },
      options.previousReport,
    );
  }

  return report;
}

/** Grade a score without running a scan. Used by CI threshold checks. */
export function gradeOf(score: number): string {
  return gradeFor(score);
}

/**
 * Everything the fixers need to know about the project, derived once per scan.
 * The `.env.example` fixer in particular is only useful if it reflects the
 * variables the code actually reads.
 */
function fixContextFor(context: ScanContext): Omit<FixContext, 'finding'> {
  const envVars = new Set<string>();
  for (const file of internals.parseAll(context, (f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb)$/.test(f.path))) {
    for (const m of file.noCommentsOrStrings.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (m[1] && m[1] !== 'NODE_ENV') envVars.add(m[1]);
    }
    for (const m of file.noCommentsOrStrings.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (m[1]) envVars.add(m[1]);
    }
    for (const m of file.content.matchAll(/os\.environ(?:\.get)?[\[(["']+([A-Z][A-Z0-9_]+)/g)) {
      if (m[1]) envVars.add(m[1]);
    }
    for (const m of file.content.matchAll(/\bos\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g)) {
      if (m[1]) envVars.add(m[1]);
    }
  }
  // Drop anything already documented in an existing .env.example.
  for (const path of context.files()) {
    if (!/^\.env(\.[\w-]+)?$/.test(path)) continue;
    const parsed = internals.parse(context, path);
    if (!parsed) continue;
    for (const line of parsed.lines) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m?.[1]) envVars.delete(m[1]);
    }
  }

  const testsDir = context.files().some((f) => /^tests?\//.test(f))
    ? 'tests'
    : context.files().some((f) => /^__tests__\//.test(f))
      ? '__tests__'
      : 'tests';

  return {
    projectType: context.project.type,
    frameworks: context.project.frameworks,
    envVars: [...envVars].sort(),
    routes: [...context.project.apiRoutes],
    testsDir,
  };
}
