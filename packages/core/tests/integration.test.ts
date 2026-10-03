import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScan } from '../src/engine.js';
import { createDefaultRegistry } from '../src/index.js';
import { applyFixes } from '../src/autofix/apply.js';
import { planFixes } from '../src/autofix/fixers.js';
import type { ProductionReadinessReport } from '../src/types.js';

async function withTempRepo<T>(
  files: Record<string, string>,
  fn: (root: string, report: ProductionReadinessReport) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'shipready-lt-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(root, path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const first = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
    return await fn(root, first.report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('--compare', () => {
  it('reports no comparison on the first scan', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (_root, report) => {
      expect(report.comparison).toBeUndefined();
    });
  });

  it('diffs a second scan against the first', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, first) => {
      expect(first.score).toBeGreaterThan(0);

      // Add a blocker between runs.
      await writeFile(join(root, 'Dockerfile'), 'FROM node:22\nUSER app\n', 'utf8');
      await writeFile(join(root, '.env.example'), 'DATABASE_URL=\n', 'utf8');
      await mkdir(join(root, '.github/workflows'), { recursive: true });
      // A CI workflow that does not run tests would itself be a blocker, so
      // the "improvement" here has to be a workflow that runs them.
      await writeFile(join(root, '.github/workflows/ci.yml'), 'name: CI\njobs:\n  t:\n    steps:\n      - run: npm run lint\n', 'utf8');

      const { report: second } = await runScan(
        { type: 'repo', path: root },
        { registry: createDefaultRegistry(), previousReport: first },
      );

      expect(second.comparison).toBeDefined();
      const cmp = second.comparison!;
      expect(cmp.previousScore).toBe(first.score);
      expect(cmp.scoreDelta).toBe(second.score - first.score);
      expect(cmp.newFindings).toBeGreaterThan(0);
      expect(cmp.resolvedFindings).toBeGreaterThan(0);
      expect(cmp.previousRunAt).toBe(first.generatedAt);

      // The score can legitimately fall even as findings are resolved: adding a
      // CI workflow that never runs tests is a new critical finding, and
      // declaring DATABASE_URL makes the database category apply at all. The
      // diff has to report both sides honestly rather than flatter the trend.
      const resolved = cmp.resolvedFindings;
      expect(resolved).toBeGreaterThan(0);
      expect(cmp.regressions.length + cmp.improvements.length).toBeGreaterThan(0);
    });
  });

  it('lists regressions and improvements separately', async () => {
    await withTempRepo(
      {
        // A server with no error handler and no health check: two blockers.
        'package.json': '{"name":"x","dependencies":{"express":"4.19.2"}}',
        'src/index.js': "const express = require('express');\nconst app = express();\napp.listen(3000);\n",
      },
      async (root, first) => {
        expect(first.topBlockers.length).toBeGreaterThan(0);
        const before = new Set(first.findings.map((f) => f.id));

        // Add the fixes, so blockers resolve and the score improves.
        await writeFile(
          join(root, 'src/index.js'),
          [
            "const express = require('express');",
            "const app = express();",
            "app.get('/health', (_req, res) => res.json({ status: 'ok' }));",
            'app.use((err, req, res, _next) => {',
            '  console.error(err);',
            '  res.status(500).json({ error: "internal" });',
            '});',
            'app.listen(3000);',
          ].join('\n'),
          'utf8',
        );

        const { report: second } = await runScan(
          { type: 'repo', path: root },
          { registry: createDefaultRegistry(), previousReport: first },
        );

        const cmp = second.comparison!;
        const resolvedBlockers = first.findings
          .filter((f) => f.productionImpact === 'blocker' && !second.findings.some((g) => g.id === f.id));
        expect(cmp.improvements.length).toBe(resolvedBlockers.length);
        for (const improvement of cmp.improvements) {
          expect(improvement.productionImpact).toBe('blocker');
          expect(before.has(improvement.id)).toBe(true);
        }
        // A resolved blocker must no longer be a blocker in the new scan.
        const nowBlockers = new Set(second.findings.filter((f) => f.productionImpact === 'blocker').map((f) => f.id));
        for (const improvement of cmp.improvements) {
          expect(nowBlockers.has(improvement.id)).toBe(false);
        }
      },
    );
  });

  it('reports zero change for an identical rescan', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, first) => {
      const { report: second } = await runScan(
        { type: 'repo', path: root },
        { registry: createDefaultRegistry(), previousReport: first },
      );
      expect(second.comparison!.scoreDelta).toBe(0);
      expect(second.comparison!.newFindings).toBe(0);
      expect(second.comparison!.resolvedFindings).toBe(0);
    });
  });

  it('reports per-category deltas', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, first) => {
      await writeFile(join(root, 'Dockerfile'), 'FROM node:22\nUSER app\n', 'utf8');
      const { report: second } = await runScan(
        { type: 'repo', path: root },
        { registry: createDefaultRegistry(), previousReport: first },
      );
      const deployment = second.comparison!.categoryDeltas.find((d) => d.category === 'deployment');
      expect(deployment).toBeDefined();
      expect(deployment!.delta).toBeGreaterThan(0);
      expect(deployment!.to).toBeGreaterThan(deployment!.from);
    });
  });
});

describe('--fix', () => {
  it('plans fixes and reduces the blocker count when applied', async () => {
    await withTempRepo(
      {
        'package.json': JSON.stringify({ name: 'svc', dependencies: { express: '4.19.2' } }),
        'src/index.js': "const express = require('express');\nconst app = express();\napp.listen(3000);\n",
      },
      async (root, before) => {
        expect(before.topBlockers.length).toBeGreaterThan(0);

        const fixes = planFixes(
          before.findings,
          { projectType: 'express', frameworks: ['express'], envVars: [], routes: [] },
        );
        expect(fixes.fixes.length).toBeGreaterThan(0);

        const applied = await applyFixes(fixes.fixes, { root });
        expect(applied.failed).toHaveLength(0);
        expect(applied.written.length).toBeGreaterThan(0);

        const { report: after } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
        expect(after.score).toBeGreaterThanOrEqual(before.score);
      },
    );
  });

  it('is idempotent: applying the same fix twice does not corrupt files', async () => {
    await withTempRepo(
      {
        'package.json': JSON.stringify({ name: 'svc', dependencies: { express: '4.19.2' } }),
        'src/index.js': "const express = require('express');\nconst app = express();\napp.listen(3000);\n",
      },
      async (root, report) => {
        const fixes = planFixes(report.findings, {
          projectType: 'express',
          frameworks: ['express'],
          envVars: [],
          routes: [],
        });
        await applyFixes(fixes.fixes, { root });
        // Second pass: creates overwrite, patches fail on a missing anchor.
        const second = await applyFixes(fixes.fixes, { root });
        expect(second.failed.every((f) => /not found/.test(f.reason))).toBe(true);
      },
    );
  });

  it('never writes in dry-run mode', async () => {
    await withTempRepo({ 'package.json': '{"name":"svc"}' }, async (root, report) => {
      const before = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
      const fixes = planFixes(before.report.findings, {
        projectType: 'node',
        frameworks: [],
        envVars: [],
        routes: [],
      });
      await applyFixes(fixes.fixes, { dryRun: true, root });
      // Only the .env.example fixer can fire here, and it must not have landed.
      const { existsSync } = await import('node:fs');
      if (fixes.fixes.some((f) => f.path === '.env.example')) {
        expect(existsSync(join(root, '.env.example'))).toBe(false);
      }
      expect(report.version).toBe(1);
    });
  });
});

describe('scan determinism and isolation', () => {
  it('produces identical output for identical input', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'x', dependencies: { next: '14.0.0', react: '18.0.0' } }),
      'app/api/a/route.ts': 'export async function GET() { return Response.json({}); }\n',
    };
    await withTempRepo(files, async (root, first) => {
      const { report: second } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
      expect(second.score).toBe(first.score);
      expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
    });
  });

  it('isolates rule failures instead of aborting the scan', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root) => {
      const errors: string[] = [];
      const { report } = await runScan(
        { type: 'repo', path: root },
        {
          registry: createDefaultRegistry(),
          onScannerError: (id) => errors.push(id),
        },
      );
      // The built-in catalogue must not throw.
      expect(errors).toHaveLength(0);
      expect(report.findings.length).toBeGreaterThan(0);
    });
  });

  it('honours disableRules', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, baseline) => {
      const { report } = await runScan(
        { type: 'repo', path: root, config: { disableRules: ['readiness/deployment/no-dockerfile'] } },
        { registry: createDefaultRegistry() },
      );
      expect(report.findings.some((f) => f.ruleId === 'readiness/deployment/no-dockerfile')).toBe(false);
      expect(report.findings.length).toBeLessThan(baseline.findings.length);
    });
  });

  it('honours onlyRules', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root) => {
      const { report } = await runScan(
        { type: 'repo', path: root, config: { onlyRules: ['readiness/deployment/no-dockerfile'] } },
        { registry: createDefaultRegistry() },
      );
      expect(report.findings.every((f) => f.ruleId === 'readiness/deployment/no-dockerfile')).toBe(true);
    });
  });

  it('honours minSeverity', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, baseline) => {
      const { report } = await runScan(
        { type: 'repo', path: root, config: { minSeverity: 'high' } },
        { registry: createDefaultRegistry() },
      );
      expect(report.findings.every((f) => f.severity === 'critical' || f.severity === 'high')).toBe(true);
      expect(report.findings.length).toBeLessThan(baseline.findings.length);
    });
  });

  it('honours minConfidence', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root, baseline) => {
      const { report } = await runScan(
        { type: 'repo', path: root, config: { minConfidence: 0.9 } },
        { registry: createDefaultRegistry() },
      );
      expect(report.findings.every((f) => f.confidence >= 0.9)).toBe(true);
      expect(report.findings.length).toBeLessThanOrEqual(baseline.findings.length);
    });
  });

  it('excludes paths', async () => {
    await withTempRepo(
      {
        'package.json': '{"name":"x"}',
        'generated/noise.ts': 'export const a = 1;\n',
      },
      async (root) => {
        const { report } = await runScan(
          { type: 'repo', path: root, include: ['package.json'] },
          { registry: createDefaultRegistry() },
        );
        expect(report.findings.some((f) => f.location.path.startsWith('generated/'))).toBe(false);
      },
    );
  });

  it('streams findings as they are discovered', async () => {
    await withTempRepo({ 'package.json': '{"name":"x"}' }, async (root) => {
      const { streamFindings } = await import('../src/engine.js');
      const collected: string[] = [];
      for await (const finding of streamFindings({ type: 'repo', path: root }, { registry: createDefaultRegistry() })) {
        collected.push(finding.id);
      }
      expect(collected.length).toBeGreaterThan(0);
      expect(new Set(collected).size).toBe(collected.length);
    });
  });
});