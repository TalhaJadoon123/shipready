import {
  applyFixes,
  createDefaultRegistry,
  DEFAULT_CI_THRESHOLD,
  DEFAULT_FIX_LIMIT,
  DEFAULT_TOP_BLOCKERS,
  formatConsole,
  formatHtml,
  formatMarkdown,
  formatReport,
  formatSarif,
  gradeOf,
  planFixes,
  readLastReport,
  setColour as setCoreColour,
  verdictFor,
  writeReport,
  type Finding,
  type ProductionReadinessReport,
  type ReportFormat,
  type ScanTarget,
  type Severity,
} from '@shipready/core';
import { runScan } from '@shipready/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { c, emit, error, heading, info, success, warn } from '../ui.js';
import { loadConfig, toScanConfig, type ShipReadyConfig } from '../config.js';

export interface ScanOptions {
  path: string;
  format: ReportFormat;
  output?: string;
  threshold?: number;
  compare: boolean;
  baseline: boolean;
  verbose: boolean;
  full: boolean;
  maxFindings?: number;
  disable: string[];
  enable: string[];
  minSeverity?: Severity;
  minConfidence?: number;
  failOn: 'blocker' | 'any' | 'never';
  include: string[];
  exclude: string[];
  maxFiles?: number;
  cwd: string;
  /** Emit GitHub annotations. */
  annotations: boolean;
  quiet: boolean;
}

export interface ScanOutcome {
  report: ProductionReadinessReport;
  exitCode: number;
  written: string | null;
}

/**
 * `shipready scan`.
 *
 * The exit code is the contract CI depends on, so it is computed from one
 * place and documented: 0 pass, 1 findings crossed the threshold or a blocker
 * exists, 2 the scan itself could not run.
 */
export async function runScanCommand(options: ScanOptions): Promise<ScanOutcome> {
  const target = resolve(options.path);
  if (!existsSync(target)) {
    error(`${options.path} does not exist`);
    return { report: emptyReport(), exitCode: 2, written: null };
  }

  const loaded = await loadConfig(options.cwd);
  for (const message of loaded.warnings) warn(message);
  const config = mergeConfig(loaded.config, options);

  // Only *enable* colour when not quiet. Blindly setting it here would undo
  // an earlier `--no-color`, because this command runs after argv parsing.
  if (options.quiet) setCoreColour(false);
  if (!options.quiet) info(c.dim(`  Scanning ${c.bold(options.path)} ...`));

  const registry = createDefaultRegistry();
  const scanTarget: ScanTarget = {
    type: 'repo',
    path: target,
    config: {
      ...toScanConfig(config),
      ...(options.minSeverity ? { minSeverity: options.minSeverity } : {}),
      ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
      ...(config.scan.disable.length > 0 ? { disableRules: config.scan.disable } : {}),
      ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    },
    include: [...config.scan.include, ...options.include],
    exclude: [...config.scan.exclude, ...options.exclude],
  };

  const previous = options.compare || options.baseline ? await readLastReport(target) : null;

  const started = Date.now();
  const errors: string[] = [];
  const { report } = await runScan(scanTarget, {
    registry,
    previousReport: previous,
    onScannerError: (id, err) => errors.push(`${id}: ${err.message}`),
  });

  for (const message of errors) warn(`rule failed -- ${message}`);

  if (!options.quiet && options.compare && !previous) {
    warn('No previous scan found. This will be the baseline for --compare.');
  }

  // Persist for the next run, but only on an unqualified scan: a scan of a
  // subdirectory should not overwrite the repository baseline.
  let written: string | null = null;
  if (!options.compare || !previous) {
    try {
      written = await writeReport(report, target);
    } catch (err) {
      warn(`Could not save the report for --compare (${(err as Error).message})`);
    }
  }

  // `--format` always wins: CI routinely writes SARIF to a file and still
  // wants a readable summary in the log.
  const rendered = formatReport(report, options.format, {
    verbose: options.verbose,
    full: options.full,
    maxFindings: options.maxFindings,
    maxBlockers: 3,
    toolName: 'ShipReady',
  });
  if (options.output && options.format !== 'console') {
    await emit(rendered, options.output);
  } else {
    // No output file, or the caller wants the terminal report.
    process.stdout.write(rendered);
  }

  if (options.annotations) emitAnnotations(report);

  if (!options.quiet) {
    const elapsed = Date.now() - started;
    info(c.dim(`  Scanned in ${elapsed} ms · report saved to ${written ?? 'nowhere'}`));
  }

  return { report, exitCode: exitCodeFor(report, config, options), written };
}

function mergeConfig(base: ShipReadyConfig, options: ScanOptions): ShipReadyConfig {
  return {
    ...base,
    scan: {
      ...base.scan,
      threshold: options.threshold ?? base.scan.threshold,
      disable: [...base.scan.disable, ...options.disable],
      minConfidence: options.minConfidence ?? base.scan.minConfidence,
      minSeverity: options.minSeverity ?? base.scan.minSeverity,
      include: [...base.scan.include, ...options.include],
      exclude: [...base.scan.exclude, ...options.exclude],
    },
  };
}

/**
 * Exit code.
 *
 * `baseline` changes the comparison from an absolute score to a regression
 * check, which is what lets an existing codebase adopt ShipReady without
 * going red on day one.
 */
export function exitCodeFor(report: ProductionReadinessReport, config: ShipReadyConfig, options: ScanOptions): number {
  if (options.failOn === 'never') return 0;

  // Counted from the findings, not the summary: the summary is derived, and
  // two sources of truth for "is there a blocker" is one source too many.
  const blockers = report.findings.filter((f) => f.productionImpact === 'blocker');

  if (options.baseline) {
    const previous = report.comparison;
    if (!previous) return 0; // first run: nothing to regress against
    if (report.score < previous.previousScore) return 1;
    if (previous.regressions.length > 0) return 1;
    return 0;
  }

  const threshold = options.threshold ?? config.scan.threshold;
  if (report.score < threshold) return 1;
  if (options.failOn === 'blocker' && blockers.length > 0) return 1;
  return 0;
}

function emitAnnotations(report: ProductionReadinessReport): void {
  // GitHub Actions workflow commands. Nothing is emitted outside CI, so a
  // developer running `shipready scan` never sees this noise.
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const level = (s: Severity): string =>
    s === 'critical' || s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'notice';
  for (const f of report.findings.slice(0, 50)) {
    process.stdout.write(
      `::${level(f.severity)} file=${f.location.path},line=${f.location.startLine}::${f.title}: ${f.evidence.summary}\n`,
    );
  }
}

function emptyReport(): ProductionReadinessReport {
  return {
    version: 1,
    score: 0,
    grade: 'F-',
    verdict: 'NOT READY',
    target: { type: 'repo', path: '.' },
    project: { type: 'unknown', frameworks: [], languages: [], totalLines: 0 },
    categories: [],
    summary: {
      totalFindings: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byImpact: { blocker: 0, degradation: 0, cosmetic: 0 },
      blockers: 0,
      fixable: 0,
      estimatedMinutesToLaunch: 0,
      estimatedTimeToLaunch: 'n/a',
    },
    topBlockers: [],
    findings: [],
    durationMs: 0,
    generatedAt: new Date().toISOString(),
  };
}

export interface FixOptions {
  path: string;
  apply: boolean;
  dryRun: boolean;
  limit: number;
  only?: string[];
  verbose: boolean;
  cwd: string;
}

export interface FixOutcome {
  fixes: { path: string; kind: string; description: string; requiresReview: boolean; bytes: number }[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
  unsupported: string[];
  exitCode: number;
}

/**
 * `shipready fix`.
 *
 * Dry run by default. Generating files into someone's repository without them
 * reading the diff is the fastest way to lose their trust permanently, so
 * `--apply` is required and is spelled out in the output.
 */
export async function runFixCommand(options: FixOptions): Promise<FixOutcome> {
  const target = resolve(options.path);
  const loaded = await loadConfig(options.cwd);
  for (const message of loaded.warnings) warn(message);

  setCoreColour(true);
  const registry = createDefaultRegistry();
  info(c.dim(`  Scanning ${c.bold(options.path)} to find fixable issues ...`));

  const { report } = await runScan(
    { type: 'repo', path: target, config: toScanConfig(loaded.config) },
    { registry },
  );

  const limit = options.limit ?? loaded.config.fix.limit ?? DEFAULT_FIX_LIMIT;
  const plan = planFixes(report.findings, fixContextFrom(report), limit);

  if (plan.fixes.length === 0) {
    info(c.yellow('  Nothing to auto-fix. Run `shipready scan` for the full list.'));
    return { fixes: [], skipped: [], failed: [], unsupported: plan.unsupportedFixable.map((f) => f.ruleId), exitCode: 0 };
  }

  heading(`  ${plan.fixes.length} fix${plan.fixes.length === 1 ? '' : 'es'} available`);
  const byRule = new Map<string, typeof plan.fixes>();
  for (const fix of plan.fixes) {
    const arr = byRule.get(fix.ruleId) ?? [];
    arr.push(fix);
    byRule.set(fix.ruleId, arr);
  }
  for (const [ruleId, fixes] of byRule) {
    const paths = fixes.map((f) => f.path).join(', ');
    info(`  ${c.green('+')} ${c.bold(ruleId)}`);
    info(`    ${c.dim(`${fixes[0]!.description}`)}`);
    info(`    ${c.dim(`writes: ${paths}`)}`);
  }

  if (options.verbose && plan.unsupportedFixable.length > 0) {
    info('');
    info(c.dim(`  ${plan.unsupportedFixable.length} fixable finding(s) have no generator and were skipped.`));
  }

  if (!options.apply) {
    info('');
    info(c.yellow('  Dry run: nothing was written.'));
    info(`  Re-run with ${c.bold('shipready fix ' + options.path + ' --apply')} to write these files.`);
    info(c.dim('  Read the diff before committing. Every generated file is marked requires-review for a reason.'));
    return {
      fixes: plan.fixes.map((f) => ({
        path: f.path,
        kind: f.kind,
        description: f.description,
        requiresReview: f.requiresReview,
        bytes: Buffer.byteLength(f.content ?? ''),
      })),
      skipped: [],
      failed: [],
      unsupported: plan.unsupportedFixable.map((f) => f.ruleId),
      exitCode: 0,
    };
  }

  info('');
  const applied = await applyFixes(plan.fixes, { dryRun: options.dryRun, root: target });
  for (const w of applied.written) success(`${w.kind} ${w.path} (${w.bytes} bytes)`);
  for (const s of applied.skipped) warn(`skipped ${s.path}: ${s.reason}`);
  for (const f of applied.failed) error(`failed ${f.path}: ${f.reason}`);

  if (applied.written.length > 0) {
    info('');
    info(c.dim('  Read the diff, then run your tests. These are starting points, not finished work.'));
  }
  return {
    fixes: applied.written.map((w) => ({
      path: w.path,
      kind: w.kind,
      description: '',
      requiresReview: true,
      bytes: w.bytes,
    })),
    skipped: applied.skipped,
    failed: applied.failed,
    unsupported: plan.unsupportedFixable.map((f) => f.ruleId),
    exitCode: applied.failed.length > 0 ? 1 : 0,
  };
}

function fixContextFrom(report: ProductionReadinessReport) {
  return {
    projectType: report.project.type,
    frameworks: report.project.frameworks,
    envVars: collectEnvVars(report),
    routes: [],
  };
}

/**
 * Environment variables the code reads, minus anything already documented.
 * Derived from the report rather than re-scanning: the fix planner runs after
 * the scan, and re-reading the tree would double the work for no benefit.
 */
function collectEnvVars(report: ProductionReadinessReport): string[] {
  const fromFindings = new Set<string>();
  for (const f of report.findings) {
    const vars = f.evidence.data?.variables;
    if (Array.isArray(vars)) for (const v of vars) if (typeof v === 'string') fromFindings.add(v);
  }
  return [...fromFindings].sort();
}

export interface ReportOptions {
  path: string;
  format: ReportFormat;
  output?: string;
  verbose: boolean;
  cwd: string;
}

/**
 * `shipready report` -- re-render the last saved scan.
 *
 * Separate from `scan` so the HTML report and the dashboard export can be
 * regenerated without re-running fifty rules.
 */
export async function runReportCommand(options: ReportOptions): Promise<ScanOutcome> {
  const target = resolve(options.path);
  const report = await readLastReport(target);
  if (!report) {
    error(`No saved scan found in ${target}. Run \`shipready scan ${options.path}\` first.`);
    return { report: emptyReport(), exitCode: 2, written: null };
  }
  setCoreColour(false);
  const rendered = formatReport(report, options.format, {
    verbose: options.verbose,
    full: true,
    toolName: 'ShipReady',
  });
  if (options.output && options.format !== 'console') {
    await emit(rendered, options.output);
  } else {
    // No output file, or the caller wants the terminal report.
    process.stdout.write(rendered);
  }
  return { report, exitCode: 0, written: options.output ?? null };
}

export { DEFAULT_CI_THRESHOLD, DEFAULT_TOP_BLOCKERS, formatConsole, formatHtml, formatMarkdown, formatSarif, gradeOf, verdictFor };
export type { Finding, ProductionReadinessReport, ScanTarget };