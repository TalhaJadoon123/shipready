import type { ComplianceAnswer, Framework } from './types.js';

import { generate, type GenerateResult } from './generate.js';

/**
 * Public API of `@shipready/compliance`.
 *
 * The shape is three functions: gather answers, find the gaps, generate the
 * documents. Everything else is a rendering concern so the same logic serves
 * the CLI, the dashboard and an API integration.
 */

// --- Questionnaire ----------------------------------------------------------
export type {
  AiRiskClass,
  AiSystemProfile,
  CompanyProfile,
  ComplianceAnswer,
  DataCategory,
  Framework,
  Gap,
  Jurisdiction,
  LawfulBasis,
  SystemRole,
} from './types.js';
export {
  ALL_FRAMEWORKS,
  REQUIRED_AI_ACT_DOCUMENTS,
  REQUIRED_CSRD_DOCUMENTS,
  REQUIRED_GDPR_DOCUMENTS,
  complianceScore,
  findGaps,
  inferFrameworks,
  isCsrdInScope,
  sortGaps,
} from './types.js';
export { QUESTIONS, questionFlow, type Question } from './questionnaire.js';

// --- Generation -------------------------------------------------------------
export {
  filenameFor,
  generate,
  listTemplateFiles,
  type GeneratedDocument,
  type GenerateOptions,
  type GenerateResult,
} from './generate.js';

// --- Codebase scan ----------------------------------------------------------
export { scanForCompliance, formatScanFindings, type ComplianceScanResult, type ComplianceScanFinding } from './scan.js';

// --- Export formats ---------------------------------------------------------
export {
  toMarkdownBundle,
  toJsonBundle,
  toDocxBundle,
  zipSync,
  type ExportFormat,
  type BundleFile,
  type BundleResult,
  type BundleManifest,
} from './export.js';

export { buildDashboard, formatComplianceReport, type ComplianceDashboard, type FrameworkStatus } from './dashboard.js';

/** Convenience: answers in, documents out. */
export function generateFor(answer: ComplianceAnswer, frameworks?: Framework[]): GenerateResult {
  return generate(answer, frameworks ? { frameworks } : {});
}