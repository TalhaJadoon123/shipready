import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { rulesFromDeclarative, type DeclarativeRule } from '../scanners/registry.js';
import type { Rule } from './scanner-helper.js';

/**
 * YAML rule packs.
 *
 * `packages/rules` ships the declarative checks as data so that a company can
 * fork a pack, edit a threshold, or add a house rule without touching
 * TypeScript. The grammar is intentionally narrow -- regex, paths, severity,
 * compliance tags -- because a general rule language is a second language to
 * document, test and debug.
 */
export interface RulePack {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  /** Minimum ShipReady core version this pack targets. */
  requires?: string;
  rules: Rule[];
  /** Non-fatal problems found while loading. */
  warnings: string[];
}

export interface PackRule extends DeclarativeRule {}

interface RawPack {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  requires?: string;
  rules?: RawRule[];
}

interface RawRule {
  id?: string;
  name?: string;
  description?: string;
  remediation?: string;
  category?: string;
  severity?: string;
  impact?: string;
  confidence?: number;
  effortMinutes?: number;
  tags?: string[];
  compliance?: { framework?: string; article?: string; requirement?: string; reference?: string; severity?: string }[];
  references?: string[];
  paths?: string[];
  pattern?: string;
  flags?: string;
  notPattern?: string;
  reportOnce?: boolean;
}

const VALID_CATEGORIES = new Set([
  'error-handling',
  'security',
  'database',
  'observability',
  'deployment',
  'performance',
  'data-integrity',
  'testing',
  'accessibility',
  'ai-specific',
]);

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_IMPACTS = new Set(['blocker', 'degradation', 'cosmetic']);

export function parseRulePack(text: string, sourceLabel = '<inline>'): RulePack {
  const warnings: string[] = [];
  let raw: RawPack;
  try {
    raw = parseYaml(text) as RawPack;
  } catch (error) {
    throw new Error(`Rule pack ${sourceLabel} is not valid YAML: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Rule pack ${sourceLabel} is empty or not a mapping`);
  }
  if (!Array.isArray(raw.rules)) {
    throw new Error(`Rule pack ${sourceLabel} must contain a "rules" array`);
  }

  const defs: DeclarativeRule[] = [];
  const seen = new Set<string>();

  raw.rules.forEach((r, i) => {
    const at = `${sourceLabel}#rules[${i}]`;
    if (!r || typeof r !== 'object') {
      warnings.push(`${at}: not a mapping, skipped`);
      return;
    }
    if (!r.id) {
      warnings.push(`${at}: missing "id", skipped`);
      return;
    }
    if (!r.id.includes('/')) {
      warnings.push(`${at}: id "${r.id}" must be namespaced with a "/" (e.g. "house/security/xyz")`);
      return;
    }
    if (seen.has(r.id)) {
      warnings.push(`${at}: duplicate id "${r.id}", skipped`);
      return;
    }
    seen.add(r.id);
    if (!r.name || !r.description || !r.remediation) {
      warnings.push(`${at} (${r.id}): missing name, description or remediation`);
      return;
    }
    if (!r.category || !VALID_CATEGORIES.has(r.category)) {
      warnings.push(`${at} (${r.id}): unknown category "${r.category}", skipped`);
      return;
    }
    if (!r.pattern) {
      warnings.push(`${at} (${r.id}): missing "pattern", skipped`);
      return;
    }
    try {
      new RegExp(r.pattern, r.flags ?? '');
    } catch (error) {
      warnings.push(`${at} (${r.id}): invalid pattern -- ${(error as Error).message}`);
      return;
    }
    if (r.severity && !VALID_SEVERITIES.has(r.severity)) {
      warnings.push(`${at} (${r.id}): invalid severity "${r.severity}", defaulting to medium`);
    }
    if (r.impact && !VALID_IMPACTS.has(r.impact)) {
      warnings.push(`${at} (${r.id}): invalid impact "${r.impact}", deriving from severity`);
    }

    defs.push({
      id: r.id,
      name: r.name,
      description: r.description,
      remediation: r.remediation,
      category: r.category as DeclarativeRule['category'],
      ...(r.severity && VALID_SEVERITIES.has(r.severity) ? { severity: r.severity as DeclarativeRule['severity'] } : {}),
      ...(r.impact && VALID_IMPACTS.has(r.impact) ? { impact: r.impact as DeclarativeRule['impact'] } : {}),
      ...(r.confidence !== undefined ? { confidence: clamp(r.confidence) } : {}),
      ...(r.effortMinutes !== undefined ? { effortMinutes: Math.max(1, Math.round(r.effortMinutes)) } : {}),
      ...(r.tags ? { tags: r.tags } : {}),
      ...(r.references ? { references: r.references } : {}),
      ...(r.paths ? { paths: r.paths } : {}),
      pattern: r.pattern,
      ...(r.flags ? { flags: r.flags } : {}),
      ...(r.notPattern ? { notPattern: r.notPattern } : {}),
      ...(r.reportOnce !== undefined ? { reportOnce: r.reportOnce } : {}),
      compliance: (r.compliance ?? []).flatMap((c) => {
        if (!c?.framework || !c?.requirement) {
          warnings.push(`${at} (${r.id}): a compliance entry is missing framework or requirement`);
          return [];
        }
        return [
          {
            framework: c.framework,
            ...(c.article ? { article: c.article } : {}),
            requirement: c.requirement,
            ...(c.severity && VALID_SEVERITIES.has(c.severity) ? { severity: c.severity as 'critical' } : {}),
            ...(c.reference ? { reference: c.reference } : {}),
          },
        ];
      }),
    });
  });

  return {
    id: raw.id ?? 'unnamed-pack',
    name: raw.name ?? 'Unnamed rule pack',
    version: raw.version ?? '0.0.0',
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.author ? { author: raw.author } : {}),
    ...(raw.license ? { license: raw.license } : {}),
    ...(raw.requires ? { requires: raw.requires } : {}),
    rules: rulesFromDeclarative(defs),
    warnings,
  };
}

export async function loadRulePack(path: string): Promise<RulePack> {
  const text = await readFile(path, 'utf8');
  return parseRulePack(text, path);
}

function clamp(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.9;
  return Math.max(0, Math.min(1, n));
}