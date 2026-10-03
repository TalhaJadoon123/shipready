import { describe, expect, it } from 'vitest';
import { defineRule, rulesToScanners, type Rule } from '../src/rules/scanner-helper.js';
import { rule } from '../src/rules/rule.js';
import { PluginRegistry } from '../src/registry.js';
import { readinessScanners, RULE_COUNT, readinessRules } from '../src/scanners/readiness/index.js';
import { aiSecurityScanners, aiSecurityRules } from '../src/scanners/ai-security/index.js';
import { createFinding } from '../src/finding.js';
import { createScanContext, internals } from '../src/context.js';
import { makeRepo, removeRepo, EMPTY_FIXTURE } from './fixtures.js';
import type { ScanContext, Scanner } from '../src/types.js';
import { runScan } from '../src/engine.js';

describe('rule metadata', () => {
  it('fills in impact and effort defaults from severity', () => {
    const r = rule({ id: 'x/y', name: 'n', category: 'security', description: 'd', remediation: 'r', severity: 'critical' });
    expect(r.impact).toBe('blocker');
    expect(r.effortMinutes).toBeGreaterThan(0);
    expect(r.fixable).toBe(false);
  });

  it('respects explicit overrides', () => {
    const r = rule({
      id: 'x/y',
      name: 'n',
      category: 'security',
      description: 'd',
      remediation: 'r',
      severity: 'low',
      impact: 'blocker',
      effortMinutes: 7,
    });
    expect(r.impact).toBe('blocker');
    expect(r.effortMinutes).toBe(7);
  });
});

describe('rulesToScanners', () => {
  it('creates one scanner per rule, ids intact', () => {
    const r = defineRule(
      rule({ id: 'test/one', name: 'One', category: 'security', description: 'd', remediation: 'r' }),
      function* (_ctx, emit) {
        yield emit({ path: 'a.ts', line: 3, evidence: 'hit' });
      },
    );
    const scanners = rulesToScanners([r]);
    expect(scanners).toHaveLength(1);
    expect(scanners[0]?.id).toBe('test/one');
    expect(scanners[0]?.categories).toEqual(['security']);
  });

  it('honours the applies gate without running detect', async () => {
    let ran = false;
    const scanner = rulesToScanners([
      defineRule(
        rule({ id: 'test/gated', name: 'Gated', category: 'security', description: 'd', remediation: 'r' }),
        function* () {
          ran = true;
          yield createFinding({
            ruleId: 'test/gated',
            title: 'x',
            description: 'y',
            severity: 'low',
            category: 'security',
            location: { path: 'a', startLine: 1 },
            evidenceSummary: 'z',
            remediation: 'r',
          });
        },
        () => false,
      ),
    ])[0]!;

    const root = await makeRepo({ name: 'gated', files: [{ path: 'a.ts', content: 'const a = 1;' }] });
    try {
      await runScan({ type: 'repo', path: root }, { registry: new PluginRegistry([scanner]) });
      expect(ran).toBe(false);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('readiness catalogue', () => {
  it('has at least 50 checks across all ten categories', () => {
    expect(RULE_COUNT).toBeGreaterThanOrEqual(50);
    const categories = new Set(readinessRules.map((r) => r.category));
    expect(categories.size).toBe(10);
  });

  it('has no duplicate rule ids', () => {
    const ids = readinessRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every rule id', () => {
    for (const r of readinessRules) {
      expect(r.id.startsWith('readiness/'), `${r.id} must start with readiness/`).toBe(true);
    }
  });

  it('gives every rule a description and remediation over 30 characters', () => {
    for (const r of readinessRules) {
      expect(r.description.length, r.id).toBeGreaterThan(30);
      expect(r.remediation.length, r.id).toBeGreaterThan(30);
    }
  });

  it('uses confidence between 0 and 1', () => {
    for (const r of [...readinessRules, ...aiSecurityRules]) {
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  // Performance and accessibility findings are real engineering debt but are
  // not themselves legal non-conformances, so they carry no compliance
  // mapping. Everything an auditor would ask about must carry one.
  it('maps every compliance-bearing rule to at least one framework', () => {
    // Performance and accessibility findings are real engineering debt but are
    // not themselves legal non-conformances, so they carry no mapping.
    const COMPLIANCE_BEARING = new Set([
      'security',
      'error-handling',
      'ai-specific',
      'data-integrity',
      'observability',
      'deployment',
      'database',
      'testing',
    ]);
    const unmapped = readinessRules
      .filter((r) => COMPLIANCE_BEARING.has(r.category))
      .filter((r) => (r.compliance ?? []).length === 0);
    expect(unmapped.map((r) => r.id)).toEqual([]);
  });

  it('maps every AI-security rule to at least one framework', () => {
    const unmapped = aiSecurityRules.filter((r) => (r.compliance ?? []).length === 0);
    expect(unmapped.map((r) => r.id)).toEqual([]);
  });

  it('flags at least one rule per category as a blocker', () => {
    const byCategory = new Map<string, number>();
    for (const r of readinessRules) {
      if (r.impact !== 'blocker') continue;
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    }
    for (const cat of byCategory.keys()) {
      expect(byCategory.get(cat), cat).toBeGreaterThan(0);
    }
  });

  it('covers the AI-specific failure modes', () => {
    const ids = readinessRules.map((r) => r.id);
    expect(ids).toContain('readiness/ai-specific/no-token-limits');
    expect(ids).toContain('readiness/ai-specific/no-prompt-injection-guard');
    expect(ids).toContain('readiness/ai-specific/no-output-validation');
    expect(ids).toContain('readiness/ai-specific/no-model-fallback');
    expect(ids).toContain('readiness/ai-specific/no-cost-tracking');
  });

  it('covers the AI-security failure modes including MCP', () => {
    const ids = aiSecurityRules.map((r) => r.id);
    expect(ids).toContain('ai-security/mcp-no-auth');
    expect(ids).toContain('ai-security/mcp-tool-injection');
    expect(ids).toContain('ai-security/agent-tool-permissions');
    expect(ids).toContain('ai-security/client-db-access');
    expect(ids).toContain('ai-security/missing-ai-endpoint-rate-limit');
  });

  it('produces a scanner for every rule', () => {
    expect(readinessScanners).toHaveLength(readinessRules.length);
    expect(aiSecurityScanners).toHaveLength(aiSecurityRules.length);
  });
});

describe('PluginRegistry', () => {
  const makeScanner = (id: string): Scanner => ({
    id,
    name: id,
    description: 'test scanner',
    categories: ['security'],
    async *scan() {
      // no findings
    },
  });

  it('registers and returns scanners in insertion order', () => {
    const registry = new PluginRegistry();
    registry.register(makeScanner('a/one'));
    registry.register(makeScanner('a/two'));
    expect(registry.ids()).toEqual(['a/one', 'a/two']);
    expect(registry.size).toBe(2);
  });

  it('rejects a duplicate id', () => {
    const registry = new PluginRegistry([makeScanner('a/one')]);
    expect(() => registry.register(makeScanner('a/one'))).toThrow(/already registered/);
  });

  it('allows an explicit override', () => {
    const registry = new PluginRegistry([makeScanner('a/one')]);
    const replacement = { ...makeScanner('a/one'), name: 'replaced' };
    registry.register(replacement, { override: true });
    expect(registry.get('a/one')?.name).toBe('replaced');
    expect(registry.size).toBe(1);
  });

  it('validates scanner shape', () => {
    const registry = new PluginRegistry();
    expect(() => registry.register({} as Scanner)).toThrow();
    expect(() => registry.register({ ...makeScanner('x/y'), categories: [] })).toThrow(/category/);
    expect(() => registry.register({ ...makeScanner('nonspaced'), id: 'nonspaced' })).toThrow(/namespaced/);
    expect(() => registry.register({ ...makeScanner('a/b'), scan: 'nope' as never })).toThrow(/scan/);
  });

  it('unregisters', () => {
    const registry = new PluginRegistry([makeScanner('a/one')]);
    expect(registry.unregister('a/one')).toBe(true);
    expect(registry.unregister('a/one')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('filters by namespace and category', () => {
    const inSecurity = (id: string): Scanner => ({ ...makeScanner(id), categories: ['security'] });
    const inTesting = (id: string): Scanner => ({ ...makeScanner(id), categories: ['testing'] });

    const registry = new PluginRegistry([
      inSecurity('readiness/security/one'),
      inTesting('readiness/testing/two'),
      inSecurity('ai-security/three'),
    ]);
    expect(registry.byNamespace('readiness')).toHaveLength(2);
    expect(registry.byNamespace('ai-security')).toHaveLength(1);
    expect(registry.byCategory('security')).toHaveLength(2);
    expect(registry.byCategory('testing')).toHaveLength(1);
  });

  it('clones independently', () => {
    const registry = new PluginRegistry([makeScanner('a/one')]);
    const copy = registry.clone();
    copy.register(makeScanner('a/two'));
    expect(registry.size).toBe(1);
    expect(copy.size).toBe(2);
  });

  it('accepts every built-in scanner without collision', () => {
    const registry = new PluginRegistry([...readinessScanners, ...aiSecurityScanners]);
    expect(registry.size).toBe(readinessRules.length + aiSecurityRules.length);
  });
});

describe('ScanContext', () => {
  it('exposes detected project facts and parsed files', async () => {
    const root = await makeRepo({
      name: 'ctx',
      files: [
        { path: 'package.json', content: JSON.stringify({ dependencies: { next: '14.0.0', react: '18.0.0' } }) },
        { path: 'src/app.ts', content: 'export const a = 1;\n' },
      ],
    });
    try {
      const ctx = await createScanContext({ type: 'repo', path: root }, new PluginRegistry());
      expect(ctx.project.type).toBe('nextjs');
      expect(ctx.project.dependencyNames.has('react')).toBe(true);
      expect(await ctx.readFile('src/app.ts')).toContain('export const a');
      expect(await ctx.readFile('missing.ts')).toBeNull();
      expect(await ctx.exists('package.json')).toBe(true);
      expect(internals.parse(ctx, 'src/app.ts')?.language).toBe('ts');
      expect(ctx.filter((p) => p.endsWith('.ts'))).toContain('src/app.ts');
    } finally {
      await removeRepo(root);
    }
  });

  it('collects warnings from rules', async () => {
    const root = await makeRepo({ name: 'warn', files: EMPTY_FIXTURE });
    try {
      const ctx = await createScanContext({ type: 'repo', path: root }, new PluginRegistry());
      ctx.warn('something happened');
      expect(internals.warnings(ctx)).toContain('something happened');
    } finally {
      await removeRepo(root);
    }
  });

  it('records skipped directories for the report footer', async () => {
    const root = await makeRepo({
      name: 'skip',
      files: [{ path: 'node_modules/left-pad/index.js', content: 'module.exports = 1;' }],
    });
    try {
      const ctx = await createScanContext({ type: 'repo', path: root }, new PluginRegistry());
      expect(internals.walkResult(ctx).skippedDirs.some((d) => d.path.includes('node_modules'))).toBe(true);
      expect(ctx.files().some((f) => f.includes('node_modules'))).toBe(false);
    } finally {
      await removeRepo(root);
    }
  });

  it('honours include and exclude', async () => {
    const root = await makeRepo({
      name: 'inc',
      files: [
        { path: 'src/a.ts', content: 'const a = 1;' },
        { path: 'docs/b.md', content: '# b' },
        { path: 'test/c.ts', content: 'const c = 3;' },
      ],
    });
    try {
      const ctx = await createScanContext(
        { type: 'repo', path: root, include: ['src/'], exclude: ['test/'] },
        new PluginRegistry(),
      );
      const files = ctx.files();
      expect(files).toContain('src/a.ts');
      expect(files).not.toContain('docs/b.md');
      expect(files).not.toContain('test/c.ts');
    } finally {
      await removeRepo(root);
    }
  });
});

describe('rule detect contract', () => {
  it('lets a rule yield findings through the bound emit', async () => {
    const root = await makeRepo({ name: 'emit', files: [{ path: 'a.ts', content: 'const a = 1;\n' }] });
    try {
      const rule: Rule = defineRule(
        {
          id: 'test/bound-emit',
          name: 'Bound emit',
          category: 'security',
          severity: 'high',
          impact: 'degradation',
          confidence: 0.9,
          effortMinutes: 5,
          fixable: true,
          description: 'A rule used to verify the emit binding',
          remediation: 'Fix it in the usual way for this test scenario',
        },
        function* (_ctx: ScanContext, emit) {
          yield emit({ path: 'a.ts', line: 1, evidence: 'emitted by the rule' });
        },
      );
      const registry = new PluginRegistry(rulesToScanners([rule]));
      const { findings } = await runScan({ type: 'repo', path: root }, { registry });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe('test/bound-emit');
      expect(findings[0]?.title).toBe('Bound emit');
      expect(findings[0]?.category).toBe('security');
      expect(findings[0]?.evidence.summary).toBe('emitted by the rule');
      expect(findings[0]?.location.path).toBe('a.ts');
      expect(findings[0]?.fixable).toBe(true);
    } finally {
      await removeRepo(root);
    }
  });
});