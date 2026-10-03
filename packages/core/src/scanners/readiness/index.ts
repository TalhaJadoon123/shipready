import { rulesToScanners, type Rule } from '../../rules/scanner-helper.js';
import { errorHandlingRules } from './error-handling.js';
import { securityRules } from './security.js';
import { databaseRules } from './database.js';
import { observabilityRules } from './observability.js';
import { deploymentRules } from './deployment.js';
import { performanceRules } from './performance.js';
import { dataIntegrityRules } from './data-integrity.js';
import { testingRules } from './testing.js';
import { accessibilityRules } from './accessibility.js';
import { aiSpecificRules } from './ai-specific.js';

/**
 * The production-readiness rule catalogue.
 *
 * 65 checks across the ten scored categories. Each is independently
 * addressable by id so `disableRules` works and `--fix` can key off it.
 */
export const readinessRules: readonly Rule[] = Object.freeze([
  ...errorHandlingRules,
  ...securityRules,
  ...databaseRules,
  ...observabilityRules,
  ...deploymentRules,
  ...performanceRules,
  ...dataIntegrityRules,
  ...testingRules,
  ...accessibilityRules,
  ...aiSpecificRules,
]);

/** Scanners for every readiness rule. */
export const readinessScanners = rulesToScanners(readinessRules);

export const RULE_COUNT = readinessRules.length;

export {
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
};