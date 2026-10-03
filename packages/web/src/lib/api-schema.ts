import { z } from 'zod';

/**
 * Request validation for the API routes.
 *
 * Shared rather than per-route so the shape of what the API accepts is one
 * file to read, and so an unauthenticated endpoint cannot accidentally accept
 * something unbounded.
 */

/** A production readiness report, as uploaded by the CLI. */
export const scanReportSchema = z.object({
  version: z.literal(1),
  score: z.number().min(0).max(100),
  grade: z.string().max(4),
  verdict: z.enum(['NOT READY', 'NEEDS WORK', 'READY WITH CAVEATS', 'PRODUCTION READY']),
  target: z.object({ type: z.string(), path: z.string().optional() }).passthrough(),
  project: z.object({
    type: z.string(),
    frameworks: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
    totalLines: z.number().default(0),
  }),
  categories: z
    .array(
      z.object({
        category: z.string(),
        label: z.string(),
        score: z.number(),
        weight: z.number(),
        findingCount: z.number(),
        blockers: z.number(),
        degradations: z.number().default(0),
        cosmetic: z.number().default(0),
        topIssues: z.array(z.object({ id: z.string(), ruleId: z.string(), title: z.string() }).passthrough()).default([]),
      }),
    )
    .default([]),
  summary: z.object({
    totalFindings: z.number(),
    bySeverity: z.record(z.number()).default({}),
    byImpact: z.record(z.number()).default({}),
    blockers: z.number(),
    fixable: z.number().default(0),
    estimatedMinutesToLaunch: z.number().default(0),
    estimatedTimeToLaunch: z.string().default(''),
  }),
  topBlockers: z
    .array(
      z.object({
        id: z.string(),
        ruleId: z.string(),
        title: z.string(),
        path: z.string(),
        line: z.number(),
        severity: z.string(),
        productionImpact: z.string(),
        rationale: z.string().default(''),
        remediation: z.string().default(''),
        effortMinutes: z.number().default(0),
        fixable: z.boolean().default(false),
      }),
    )
    .default([]),
  findings: z
    .array(
      z.object({
        id: z.string(),
        ruleId: z.string(),
        title: z.string(),
        severity: z.string(),
        confidence: z.number().default(0),
        category: z.string(),
        productionImpact: z.string(),
        path: z.string().optional(),
        location: z.object({ path: z.string(), startLine: z.number().default(1) }).optional(),
        effortMinutes: z.number().default(0),
        fixable: z.boolean().default(false),
      }),
    )
    .default([]),
  durationMs: z.number().default(0),
  generatedAt: z.string(),
});

export type ScanReport = z.infer<typeof scanReportSchema>;

export const postScanSchema = z.object({
  projectId: z.string().min(1).max(200),
  report: scanReportSchema,
  commitSha: z.string().max(64).optional(),
  branch: z.string().max(200).optional(),
});

export const scanQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const findingsQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  scanId: z.coerce.number().int().optional(),
  severity: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const trendsQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(365).default(60),
});

/** Raw invoice XML. Bounded: this is a document, not a payload. */
export const validateInvoiceSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  xml: z.string().min(1).max(5_000_000),
  /** Apply safe corrections before validating. */
  fix: z.boolean().default(false),
});

/** An observed trace summary, as recorded by the CLI. */
export const postTraceSchema = z.object({
  projectId: z.string().min(1).max(200),
  trace: z.object({
    id: z.string().min(1).max(200),
    startedAt: z.string(),
    command: z.string().max(4000),
    durationMs: z.number().default(0),
    exitCode: z.number().optional(),
    totalCostUsd: z.number().default(0),
    costComplete: z.boolean().default(true),
    totalInputTokens: z.number().default(0),
    totalOutputTokens: z.number().default(0),
    llmCalls: z.number().default(0),
    toolCalls: z.number().default(0),
    errors: z.number().default(0),
    byModel: z.record(z.unknown()).default({}),
    toolDistribution: z.record(z.number()).default({}),
    hosts: z.array(z.string()).default([]),
    anomalies: z.array(z.unknown()).default([]),
  }),
});

export const traceQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/**
 * Compliance pack metadata.
 *
 * Only the version, score and gaps: the documents stay on the user's
 * filesystem, and only the gap list is needed to trend readiness over time.
 */
export const postComplianceSchema = z.object({
  projectId: z.string().min(1).max(200),
  pack: z.object({
    company: z.string().min(1).max(400),
    systemName: z.string().min(1).max(400),
    jurisdiction: z.string().min(1).max(40),
    frameworks: z.array(z.string()).default([]),
    score: z.number().min(0).max(100),
    gaps: z.array(z.unknown()).default([]),
    documentCount: z.number().default(0),
  }),
});

export const complianceQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export const projectSchema = z.object({
  name: z.string().min(1).max(200),
  repository: z.string().url().optional(),
  defaultBranch: z.string().min(1).max(200).default('main'),
});

/** Parse and return, or a 400-shaped error. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> | { error: string; issues: unknown } {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  return {
    error: 'invalid request',
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

export function isError(value: unknown): value is { error: string; issues: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value;
}