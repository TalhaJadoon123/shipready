import { emit as emitFinding, type EmitInput, type RuleMeta } from './rule.js';
import type { Finding, ScanContext, Scanner } from '../types.js';

/**
 * A check is a rule (static metadata) plus a detector.
 *
 * Making every check its own `Scanner` rather than one big scanner per
 * category is a deliberate trade. It costs a few dozen objects, and it buys
 * `disableRules: ['readiness/security/no-rate-limiting']` working exactly as
 * written, clean SARIF rule attribution, and a plugin boundary per check.
 */
export interface Rule extends RuleMeta {
  /**
   * Produce findings. Receives an `emit` bound to this rule's metadata so a
   * detector only has to describe the occurrence, not repeat the rule.
   */
  detect(ctx: ScanContext, emit: EmitFn): AsyncGenerator<Finding> | Iterable<Finding> | void;
  /** Cheap gate. Most rules skip most of the repo, so this is the hot path. */
  applies?(ctx: ScanContext): boolean;
}

export type EmitFn = (input: EmitInput) => Finding;

export function defineRule(
  meta: RuleMeta,
  detect: (ctx: ScanContext, emit: EmitFn) => AsyncGenerator<Finding> | Iterable<Finding> | void,
  applies?: (ctx: ScanContext) => boolean,
): Rule {
  return { ...meta, detect, ...(applies ? { applies } : {}) };
}

/** Wrap a set of rules as individually registerable scanners. */
export function rulesToScanners(rules: readonly Rule[]): Scanner[] {
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    version: '1.0.0',
    description: r.description,
    categories: [r.category],
    async *scan(ctx: ScanContext): AsyncGenerator<Finding> {
      if (r.applies && !r.applies(ctx)) return;
      const emit: EmitFn = (input) => emitFinding(ctx, r, input);
      const result = r.detect(ctx, emit);
      if (!result) return;
      if (isAsyncIterable(result)) {
        for await (const f of result) yield f;
      } else {
        for (const f of result) yield f;
      }
    },
  }));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Finding> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in (value as object);
}
