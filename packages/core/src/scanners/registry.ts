import { PluginRegistry } from '../registry.js';
import { internals } from '../context.js';
import { aiSecurityScanners } from './ai-security/index.js';
import { readinessScanners } from './readiness/index.js';
import { rulesToScanners, type Rule } from '../rules/scanner-helper.js';
import { rule, type RuleMeta } from '../rules/rule.js';
import type { ComplianceMapping, Finding, ProductionImpact, ReadinessCategory, Severity } from '../types.js';
import { emit, type EmitInput } from '../rules/rule.js';
import type { ScanContext } from '../types.js';

/**
 * Re-exported so `loadRegistry` in the package index has one import site, and
 * so downstream packages can extend the default registry without reaching into
 * the scanner directory layout.
 */
export function defaultScanners(): PluginRegistry {
  return new PluginRegistry([...readinessScanners, ...aiSecurityScanners]);
}

/**
 * Turn declarative YAML rules into `Rule` objects.
 *
 * The YAML packs in `packages/rules` cover the checks that are pure
 * pattern matches. Anything requiring real analysis belongs in TypeScript,
 * where it can be tested -- so this loader supports a deliberately narrow
 * grammar rather than growing into a second language.
 */
export function rulesFromDeclarative(defs: readonly DeclarativeRule[]): Rule[] {
  return defs.map((def) => ruleFromDeclarative(def));
}

export interface DeclarativeRule {
  id: string;
  name: string;
  description: string;
  remediation: string;
  category: ReadinessCategory;
  severity?: Severity;
  impact?: ProductionImpact;
  confidence?: number;
  effortMinutes?: number;
  tags?: string[];
  compliance?: ComplianceMapping[];
  references?: string[];
  /** Glob-ish path patterns to restrict the check to. */
  paths?: string[];
  /** A regular expression source string matched per line. */
  pattern?: string;
  flags?: string;
  /** Negative lookahead/lookbehind style escape: `notPattern`. */
  notPattern?: string;
  /** Emit one finding per file instead of one per matching line. */
  reportOnce?: boolean;
}

function ruleFromDeclarative(def: DeclarativeRule): Rule {
  const meta: RuleMeta = rule({
    id: def.id,
    name: def.name,
    description: def.description,
    remediation: def.remediation,
    category: def.category,
    severity: def.severity ?? 'medium',
    impact: def.impact,
    confidence: def.confidence ?? 0.9,
    effortMinutes: def.effortMinutes ?? 30,
    fixable: false,
    tags: def.tags ?? [],
    compliance: def.compliance ?? [],
    references: def.references ?? [],
  });

  let re: RegExp | null = null;
  let notRe: RegExp | null = null;
  try {
    re = def.pattern ? new RegExp(def.pattern, def.flags ?? '') : null;
    notRe = def.notPattern ? new RegExp(def.notPattern, def.flags ?? '') : null;
  } catch {
    // An invalid pattern makes the rule inert rather than fatal.
  }

  return {
    ...meta,
    detect(ctx: ScanContext, emitOne: (input: EmitInput) => Finding) {
      const findings: Finding[] = [];
      const pathRe = def.paths?.length ? new RegExp(def.paths.join('|')) : null;
      for (const path of ctx.files()) {
        if (pathRe && !pathRe.test(path)) continue;
        const file = internals.parse(ctx, path);
        if (!file || !re) continue;
        for (const hit of file.matchNoComments(re)) {
          if (notRe && notRe.test(hit.text)) continue;
          findings.push(
            emitOne({
              path: file.path,
              line: hit.line,
              snippet: hit.text,
              evidence: `${meta.name}: matched \`${hit.match}\``,
            }),
          );
          if (def.reportOnce) break;
        }
      }
      return findings;
    },
  };
}

export { rulesToScanners, emit };