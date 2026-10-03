/**
 * ShipReady core type model.
 *
 * These types are the contract between the scanning engine, every scanner
 * (built-in and third-party), the scoring algorithm and all output formatters.
 * They are intentionally serialisable so a whole scan can be shipped over the
 * wire to the hosted dashboard.
 */

/** How bad a finding is, independent of whether it blocks launch. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * What a finding actually costs you in production.
 *
 * - `blocker`     real users lose data, money, or trust. Do not launch.
 * - `degradation` real users have a worse experience. Fix soon.
 * - `cosmetic`    an engineer would notice. Fix when convenient.
 */
export type ProductionImpact = 'blocker' | 'degradation' | 'cosmetic';

/** The ten readiness categories scored 0-100 by the engine. */
export type ReadinessCategory =
  | 'error-handling'
  | 'security'
  | 'database'
  | 'observability'
  | 'deployment'
  | 'performance'
  | 'data-integrity'
  | 'testing'
  | 'accessibility'
  | 'ai-specific';

/** What kind of thing we are scanning. */
export type ScanTargetType = 'repo' | 'agent' | 'runtime' | 'invoice';

export interface ScanTarget {
  type: ScanTargetType;
  /** Filesystem path for `repo` and `agent` targets. */
  path?: string;
  /** URL for `runtime` and `invoice` targets. */
  url?: string;
  /** Raw document body for `invoice` targets. */
  content?: string;
  /** Caller-supplied configuration: rule toggles, thresholds, severities. */
  config?: ScanConfig;
  /** Restrict the scan to these subpaths. */
  include?: string[];
  /** Skip these subpaths even if inside `include`. */
  exclude?: string[];
}

export interface ScanConfig {
  /** Disable specific rules by id. */
  disableRules?: string[];
  /** Run only these rules. Mutually exclusive with `disableRules` in practice. */
  onlyRules?: string[];
  /** Downgrade findings below this severity out of the report. */
  minSeverity?: Severity;
  /** Ignore findings with confidence below 0-1. */
  minConfidence?: number;
  /** Weight overrides per readiness category. */
  categoryWeights?: Partial<Record<ReadinessCategory, number>>;
  /** Skip network-dependent checks (e.g. known-vulnerable dependency lookups). */
  offline?: boolean;
  /** Maximum files to walk. Guards against scanning `node_modules` by accident. */
  maxFiles?: number;
  /** Free-form per-rule configuration: `{ 'my-rule': { threshold: 3 } }`. */
  ruleConfig?: Record<string, Record<string, unknown>>;
  /** Compliance frameworks to map findings onto. */
  complianceFrameworks?: string[];
}

/** Where in the code a finding lives. 1-based, matching editors. */
export interface SourceLocation {
  path: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  /** The offending line(s), truncated. */
  snippet?: string;
}

export interface Evidence {
  /** One-line human explanation of what was observed. */
  summary: string;
  /** The literal matched text. */
  snippet?: string;
  /** Structured data backing the finding (counts, names, endpoints...). */
  data?: Record<string, unknown>;
}

export type ComplianceFramework =
  | 'eu-ai-act'
  | 'gdpr'
  | 'csrd'
  | 'owasp-top-10'
  | 'owasp-llm-top-10'
  | 'soc2'
  | 'iso-27001'
  | 'nis2'
  | 'e-invoicing'
  | string;

export interface ComplianceMapping {
  framework: ComplianceFramework;
  /** Article / section / control identifier. e.g. "Article 15". */
  article?: string;
  /** Short requirement name. */
  requirement: string;
  /** How severe the non-conformance is for an auditor. */
  severity?: Severity;
  /** Canonical reference URL. */
  reference?: string;
}

/** A single, addressable problem found in a codebase or runtime. */
export interface Finding {
  /** Stable, content-derived id. Same problem in the same place => same id. */
  id: string;
  /** Rule that produced it, e.g. `readiness/error-handling/no-global-handler`. */
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  /** 0-1. How sure the engine is that this is a real problem. */
  confidence: number;
  category: ReadinessCategory;
  location: SourceLocation;
  evidence: Evidence;
  remediation: string;
  compliance: ComplianceMapping[];
  productionImpact: ProductionImpact;
  /** Free-form labels for filtering and reporting. */
  tags: string[];
  /** CWE identifier where applicable. */
  cwe?: string;
  /** OWASP identifier where applicable. */
  owasp?: string;
  /** True when `--fix` can generate a real fix. */
  fixable: boolean;
  /** Minutes of engineer time to fix, estimated from the rule metadata. */
  effortMinutes: number;
  /** Documentation links. */
  references: string[];
  /** Scanner that produced this finding. */
  source: string;
}

/** Ordered severity rank. Higher is worse. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const CATEGORY_LABELS: Record<ReadinessCategory, string> = {
  'error-handling': 'Error Handling',
  security: 'Security',
  database: 'Database',
  observability: 'Observability',
  deployment: 'Deployment',
  performance: 'Performance',
  'data-integrity': 'Data Integrity',
  testing: 'Testing',
  accessibility: 'Accessibility',
  'ai-specific': 'AI Safety & Cost',
};

/**
 * Default category weights for the overall Production Readiness Score.
 *
 * Rationale: security and error handling dominate because they are the two
 * things that turn "works on my machine" into "harmed a customer". AI safety
 * is weighted heavily because it is the failure mode unique to this codebase
 * generation. Weights are normalised, so they need not sum to 100.
 */
export const DEFAULT_CATEGORY_WEIGHTS: Record<ReadinessCategory, number> = {
  'error-handling': 14,
  security: 16,
  database: 9,
  observability: 12,
  deployment: 11,
  performance: 8,
  'data-integrity': 10,
  testing: 10,
  accessibility: 4,
  'ai-specific': 6,
};

/** Everything a scanner needs to do its job. */
export interface ScanContext {
  target: ScanTarget;
  /** Project facts detected once per scan and shared by every rule. */
  project: ProjectProfile;
  /** Read a file's text, memoised. Paths are repo-relative POSIX paths. */
  readFile(path: string): Promise<string | null>;
  /** Test whether a repo-relative path exists. */
  exists(path: string): Promise<boolean>;
  /** List of every file in scope, repo-relative POSIX paths. */
  files(): readonly string[];
  /** Files matching a predicate, already cached. */
  filter(predicate: (path: string) => boolean): readonly string[];
  config: ScanConfig;
  /** Report a non-fatal problem without aborting the scan. */
  warn(message: string): void;
  /** Register an extra plugin scanner discovered mid-scan. */
  registry: PluginRegistryLike;
}

export interface PluginRegistryLike {
  register(scanner: Scanner, options?: RegisterOptions): void;
  all(): readonly Scanner[];
  get(id: string): Scanner | undefined;
}

export interface RegisterOptions {
  /** Replace an existing scanner with the same id instead of throwing. */
  override?: boolean;
}

/** The contract every scanner implements. */
export interface Scanner {
  /** Unique, namespaced. `readiness/error-handling/no-global-handler`. */
  id: string;
  name: string;
  version?: string;
  description: string;
  /** Categories this scanner contributes findings to. */
  categories: ReadinessCategory[];
  /** Run the scan, streaming findings as they are discovered. */
  scan(context: ScanContext): AsyncIterable<Finding>;
}

/** The project facts every rule can read instead of re-deriving them. */
export interface ProjectProfile {
  root: string;
  /** Best-guess stack. */
  type: ProjectType;
  /** All detected stacks, e.g. `['nextjs', 'prisma', 'postgres']`. */
  frameworks: string[];
  languages: string[];
  packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun' | 'unknown';
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
  hasEnvExample: boolean;
  isMonorepo: boolean;
  dependencyNames: Set<string>;
  scriptNames: Set<string>;
  /** Concatenated text of every dotenv file. Used to prove a var is used. */
  envKeys: Set<string>;
  /** Everything in package.json / pyproject / go.mod / Cargo.toml. */
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
  /** Route or handler files discovered for API-surface rules. */
  apiRoutes: string[];
  /** Component files, for accessibility rules. */
  components: string[];
  /** Total lines of code in scope. */
  totalLines: number;
  /** True when a git repository is present. */
  isGitRepo: boolean;
  /** Current branch name when known. */
  branch?: string;
  /** The commit sha when known. */
  commit?: string;
  /** Per-language line counts. */
  linesByLanguage: Record<string, number>;
}

export type ProjectType =
  | 'nextjs'
  | 'vite'
  | 'express'
  | 'fastapi'
  | 'django'
  | 'go'
  | 'rust'
  | 'python'
  | 'node'
  | 'unknown';

/** Launch verdict derived from the overall score and blocker count. */
export type Verdict =
  | 'NOT READY'
  | 'NEEDS WORK'
  | 'READY WITH CAVEATS'
  | 'PRODUCTION READY';

export interface CategoryScore {
  category: ReadinessCategory;
  label: string;
  /** 0-100. 100 means no findings in this category. */
  score: number;
  weight: number;
  findingCount: number;
  blockers: number;
  degradations: number;
  cosmetic: number;
  /** Findings that dragged the score down, worst first. */
  topIssues: FindingSummary[];
}

export interface FindingSummary {
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  productionImpact: ProductionImpact;
  confidence: number;
  path: string;
  line: number;
  effortMinutes: number;
  fixable: boolean;
}

export interface Blocker extends FindingSummary {
  /** Why this blocks launch, in one sentence. */
  rationale: string;
  remediation: string;
  /** Concrete fix description, present when `fixable`. */
  autoFix?: AutoFixPlan;
}

export interface AutoFixPlan {
  ruleId: string;
  description: string;
  /** Files this fix would create. */
  create: { path: string; content: string }[];
  /** Files this fix would modify. */
  modify: { path: string; edits: TextEdit[] }[];
  /** True when the generated fix should be reviewed by a human. */
  requiresReview: boolean;
}

export interface TextEdit {
  /** Exact text to find. Must be unique in the file. */
  find: string;
  replace: string;
  /** When true, `find` may match many places. */
  replaceAll?: boolean;
}

export interface ProductionReadinessReport {
  /** Schema version so the dashboard can migrate old payloads. */
  version: 1;
  score: number;
  grade: string;
  verdict: Verdict;
  target: ScanTarget;
  project: {
    type: ProjectType;
    frameworks: string[];
    languages: string[];
    totalLines: number;
  };
  categories: CategoryScore[];
  summary: {
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    byImpact: Record<ProductionImpact, number>;
    blockers: number;
    fixable: number;
    /** Minutes to make every blocker go away. */
    estimatedMinutesToLaunch: number;
    /** Human phrasing of the estimate, e.g. "about 6 hours". */
    estimatedTimeToLaunch: string;
  };
  /** Top 5 blockers that must be fixed before launch. */
  topBlockers: Blocker[];
  /** Every finding, worst first. */
  findings: Finding[];
  /** Score change versus the comparison scan, when `--compare` is used. */
  comparison?: ScanComparison;
  durationMs: number;
  generatedAt: string;
}

export interface ScanComparison {
  previousScore: number;
  scoreDelta: number;
  newFindings: number;
  resolvedFindings: number;
  previousRunAt?: string;
  blockersDelta: number;
  categoryDeltas: { category: ReadinessCategory; label: string; from: number; to: number; delta: number }[];
  regressions: Blocker[];
  improvements: Blocker[];
}
