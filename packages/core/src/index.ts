/**
 * Public API of `@shipready/core`.
 *
 * Three things live here: the scanning engine, the built-in rule catalogue,
 * and the report formatters. Everything else is an implementation detail and
 * may change between minor versions.
 */

// --- Types ------------------------------------------------------------------
export type {
  AutoFixPlan,
  Blocker,
  CategoryScore,
  ComplianceFramework,
  ComplianceMapping,
  Evidence,
  Finding,
  FindingSummary,
  ProductionImpact,
  ProductionReadinessReport,
  ProjectProfile,
  ProjectType,
  ReadinessCategory,
  ScanComparison,
  ScanConfig,
  ScanTarget,
  ScanTargetType,
  Severity,
  SourceLocation,
  TextEdit,
  Verdict,
} from './types.js';

export { SEVERITY_ORDER, SEVERITY_RANK, CATEGORY_LABELS, DEFAULT_CATEGORY_WEIGHTS } from './types.js';

// --- Finding model ----------------------------------------------------------
export {
  clamp01,
  createFinding,
  dedupeFindings,
  impactFor,
  stableId,
  toBlocker,
  toSummary,
  truncate,
} from './finding.js';

// --- Engine -----------------------------------------------------------------
export { runScan, streamFindings, gradeOf, type ScanOptions, type ScanResult } from './engine.js';
export { createScanContext, internals, type ScanContext } from './context.js';
export { DEFAULT_CI_THRESHOLD, DEFAULT_FIX_LIMIT, DEFAULT_TOP_BLOCKERS } from './config.js';

// --- Plugin registry --------------------------------------------------------
export { PluginRegistry, defineScanner } from './registry.js';

// --- Rule authoring ---------------------------------------------------------
export {
  COMPLIANCE,
  eachFile,
  emit,
  filesWithExtensions,
  lineOfFirstMatch,
  rule,
  type EmitInput,
  type RuleMeta,
} from './rules/rule.js';
export { defineRule, rulesToScanners, type EmitFn, type Rule } from './rules/scanner-helper.js';
export { loadRulePack, parseRulePack, type RulePack, type PackRule } from './rules/yaml-pack.js';

// --- Scoring ----------------------------------------------------------------
export {
  compareScans,
  gradeFor,
  humanDuration,
  scoreCategories,
  summarize,
  topBlockers,
  verdictFor,
  worseFirst,
} from './scoring.js';

// --- Source analysis --------------------------------------------------------
export {
  extractComments,
  isJavaScriptLike,
  isTypeScript,
  languageOf,
  lineOfOffset,
  lineText,
  lineTexts,
  maskComments,
  maskCommentsAndStrings,
  matchAll,
  matchLines,
  SourceFile,
  SourceSet,
  type Language,
  type LineMatch,
} from './source.js';

// --- Filesystem -------------------------------------------------------------
export {
  walk,
  readText,
  createReadCache,
  fileExists,
  pathExists,
  isDirectory,
  type ReadCache,
  type WalkResult,
} from './fsutil/walk.js';
export { buildDefaultIgnoreMatcher, IgnoreMatcher, isBinaryPath, DEFAULT_IGNORED_DIRS } from './fsutil/ignore.js';
export { detectProject } from './fsutil/detect.js';

// --- Built-in rules ---------------------------------------------------------
export {
  readinessRules,
  readinessScanners,
  RULE_COUNT,
  errorHandlingRules,
  securityRules,
  databaseRules,
  observabilityRules,
  deploymentRules,
  performanceRules,
  dataIntegrityRules,
  testingRules,
  accessibilityRules,
  aiSpecificRules,
} from './scanners/readiness/index.js';
export { aiSecurityRules, aiSecurityScanners } from './scanners/ai-security/index.js';

// --- Auto-fix ---------------------------------------------------------------
export { planFixes, FIXABLE_RULES, type FixPlanResult, type FileFix, type FixContext } from './autofix/index.js';
export { applyFixes, readLastReport, writeReport, reportPath, historyDir, listHistory, type ApplyResult } from './autofix/apply.js';

// --- Report formatters ------------------------------------------------------
export {
  formatReport,
  formatConsole,
  formatJson,
  formatMarkdown,
  formatSarif,
  parseSarif,
  formatHtml,
  formatGithubComment,
  formatGithubSummary,
  setColour,
  isColour,
  scoreBar,
  gradeBadge,
  verdictBadge,
  severityBadge,
  type FormatOptions,
  type ReportFormat,
  type MarkdownOptions,
  type SarifLog,
  toScanSummary,
  type ScanSummaryJson,
} from './report/index.js';



import { PluginRegistry } from './registry.js';
import { readinessScanners } from './scanners/readiness/index.js';
import { aiSecurityScanners, aiSecurityRules } from './scanners/ai-security/index.js';
import { loadRulePack } from './rules/yaml-pack.js';
import type { EmitFn } from './rules/scanner-helper.js';
import type { Finding } from './types.js';

/** The registry ShipReady uses when no plugins are supplied. */
export function createDefaultRegistry(): PluginRegistry {
  return new PluginRegistry([...readinessScanners, ...aiSecurityScanners]);
}

/**
 * Load the default registry plus any YAML rule packs found in `rulePackPaths`.
 * Used by the CLI so `packages/rules` ships as data rather than code.
 */
export async function loadRegistry(rulePackPaths: readonly string[] = []): Promise<PluginRegistry> {
  const registry = createDefaultRegistry();
  for (const path of rulePackPaths) {
    try {
      const pack = await loadRulePack(path);
      for (const rule of pack.rules) {
        registry.register(
          {
            id: rule.id,
            name: rule.name,
            version: '1.0.0',
            description: rule.description,
            categories: [rule.category],
            async *scan(ctx) {
              // A declarative rule builds its own findings from the `emit`
              // it is handed; the engine does not need to add anything.
              const emit: EmitFn = () => {
                throw new Error(`rule ${rule.id} called emit outside its detector`);
              };
              const produced = rule.detect(ctx, emit);
              if (!produced) return;
              if (Symbol.asyncIterator in Object(produced)) {
                for await (const f of produced as AsyncIterable<Finding>) yield f;
              } else {
                for (const f of produced as Iterable<Finding>) yield f;
              }
            },
          },
          { override: true },
        );
      }
    } catch {
      // A broken pack must not prevent the built-in rules from running.
    }
  }
  return registry;
}

export { aiSecurityRules as aiSecurityRuleDefs };