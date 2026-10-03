import { readinessRules } from '@shipready/core';
import type { RuleMeta } from '@shipready/core';

/**
 * Rule metadata for the `rules` command.
 *
 * The catalogue is re-exported rather than duplicated so `shipready rules`
 * always reflects the rules that actually run. A second list would drift.
 */
export const ruleCatalog: readonly RuleMeta[] = readinessRules as unknown as readonly RuleMeta[];

export { readinessRules as rules };
export const ruleCount = readinessRules.length;

export interface RuleSummary {
  id: string;
  name: string;
  category: string;
  severity: string;
  impact: string;
  effortMinutes: number;
  fixable: boolean;
}

/** Flatten the catalogue for machine consumption. */
export function summariseRules(
  rules: readonly RuleMeta[] = ruleCatalog,
  fixable: Readonly<Record<string, unknown>> = {},
): RuleSummary[] {
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    category: rule.category,
    severity: rule.severity,
    impact: rule.impact,
    effortMinutes: rule.effortMinutes,
    fixable: Boolean(fixable[rule.id]),
  }));
}