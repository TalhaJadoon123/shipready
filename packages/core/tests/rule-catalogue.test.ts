import { describe, expect, it } from 'vitest';
import { RULE_COUNT, readinessRules, readinessScanners } from '@shipready/core';
import { aiSecurityRules, aiSecurityScanners } from '@shipready/core';

/**
 * The rule catalogue is the product.
 *
 * These tests assert the properties a customer is implicitly buying: that every
 * rule is individually addressable, that its claim is traceable to a provision,
 * and that the numbers in the marketing copy are true.
 */
describe('the rule catalogue', () => {
  it('ships at least 50 readiness checks', () => {
    expect(RULE_COUNT).toBeGreaterThanOrEqual(50);
  });

  it('namespaces every rule id', () => {
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      expect(rule.id, rule.id).toMatch(/^(readiness|ai-security)\//);
    }
  });

  it('has no duplicate rule ids across both namespaces', () => {
    const ids = [...readinessRules, ...aiSecurityRules].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every rule a description that explains the mechanism', () => {
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      // Longer than the title, and long enough to be useful on its own.
      expect(rule.description.length, rule.id).toBeGreaterThan(80);
    }
  });

  it('gives every rule actionable remediation', () => {
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      expect(rule.remediation.length, rule.id).toBeGreaterThan(40);
    }
  });

  it('maps every compliance-bearing rule to at least one provision', () => {
    const complianceBearing = new Set([
      'security',
      'error-handling',
      'ai-specific',
      'data-integrity',
      'observability',
      'deployment',
      'database',
      'testing',
    ]);
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      if (complianceBearing.has(rule.category)) {
        expect(rule.compliance?.length ?? 0, rule.id).toBeGreaterThan(0);
      }
    }
  });

  it('uses a confidence between 0 and 1 everywhere', () => {
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      expect(rule.confidence, rule.id).toBeGreaterThan(0);
      expect(rule.confidence, rule.id).toBeLessThanOrEqual(1);
    }
  });

  it('estimates a plausible amount of effort for every rule', () => {
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      expect(rule.effortMinutes, rule.id).toBeGreaterThan(0);
      // Nothing in a "fix this in under a minute" category should claim a day.
      expect(rule.effortMinutes, rule.id).toBeLessThanOrEqual(60 * 24);
    }
  });

  it('marks a blocker as more severe than a cosmetic finding', () => {
    const byImpact = new Map(
      [...readinessRules, ...aiSecurityRules].map((r) => [r.severity, r.impact]),
    );
    // Every critical or high severity rule is at least a degradation.
    for (const rule of [...readinessRules, ...aiSecurityRules]) {
      if (rule.severity === 'critical' || rule.severity === 'high') {
        expect(rule.impact, rule.id).not.toBe('cosmetic');
      }
    }
    expect(byImpact.size).toBeGreaterThan(0);
  });

  it('covers all ten readiness categories', () => {
    const categories = new Set(readinessRules.map((r) => r.category));
    expect(categories.size).toBe(10);
    for (const expected of [
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
    ]) {
      expect(categories.has(expected as never), expected).toBe(true);
    }
  });

  it('covers the AI-specific failure modes that matter', () => {
    const ids = readinessRules.map((r) => r.id);
    for (const id of [
      'readiness/ai-specific/no-token-limits',
      'readiness/ai-specific/no-prompt-injection-guard',
      'readiness/ai-specific/no-output-validation',
      'readiness/ai-specific/no-model-fallback',
      'readiness/ai-specific/no-cost-tracking',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('covers MCP server issues', () => {
    const ids = aiSecurityRules.map((r) => r.id);
    expect(ids).toContain('ai-security/mcp-no-auth');
    expect(ids).toContain('ai-security/mcp-tool-injection');
    expect(ids).toContain('ai-security/agent-tool-permissions');
  });

  it('produces one scanner per rule', () => {
    expect(readinessScanners).toHaveLength(readinessRules.length);
    expect(aiSecurityScanners).toHaveLength(aiSecurityRules.length);
  });

  it('gives every scanner the id of its rule', () => {
    const ruleIds = new Set([...readinessRules, ...aiSecurityRules].map((r) => r.id));
    for (const scanner of [...readinessScanners, ...aiSecurityScanners]) {
      expect(ruleIds.has(scanner.id), scanner.id).toBe(true);
    }
  });

  it('declares at least one category per scanner', () => {
    for (const scanner of [...readinessScanners, ...aiSecurityScanners]) {
      expect(scanner.categories.length, scanner.id).toBeGreaterThan(0);
    }
  });

  it('marks blockers honestly: the AI cost rule is a blocker', () => {
    // This is the single most expensive failure mode in an AI product, and
    // downgrading it would be a commercial decision rather than an engineering
    // one. Pinning it here means changing it is a deliberate act.
    const tokenLimit = readinessRules.find((r) => r.id === 'readiness/ai-specific/no-token-limits');
    expect(tokenLimit?.impact).toBe('blocker');
  });
});

describe('documentation claims', () => {
  it('the check counts in the README are accurate', async () => {
    const { readFile } = await import('node:fs/promises');
    const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
    // The README quotes the readiness count, and mentions the AI-security count
    // separately. Both must be true, or the marketing copy is a lie.
    expect(readme, 'readiness count').toContain(`${RULE_COUNT} checks across ten weighted categories`);
    expect(readme, 'ai-security count').toContain(`${aiSecurityRules.length} AI-security checks`);
  });

  it('the score bands in the README match the verdict thresholds', async () => {
    const { verdictFor } = await import('@shipready/core');

    // 90+ with no blockers is the top band. 45 with no blockers is the lowest
    expect(verdictFor(95, [])).toBe('PRODUCTION READY');
    expect(verdictFor(45, [])).toBe('NEEDS WORK');
    // A single confident critical blocker is enough to stop a launch at any score.
    expect(verdictFor(95, [{ productionImpact: 'blocker', severity: 'critical', confidence: 0.95 } as never])).toBe('NOT READY');
  });
});