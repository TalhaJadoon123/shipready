import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFixes } from '../src/autofix/apply.js';
import { FIXABLE_RULES, listTemplates, planFixes, render } from '../src/autofix/fixers.js';
import { makeRepo, removeRepo } from './fixtures.js';
import type { FileFix } from '../src/autofix/fixers.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shipready-fix-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fix = (over: Partial<FileFix> = {}): FileFix => ({
  ruleId: 'test/rule',
  title: 'Test fix',
  description: 'A generated fix used in tests',
  path: 'new-file.ts',
  kind: 'create',
  content: 'export const x = 1;\n',
  requiresReview: true,
  category: 'security',
  severity: 'high',
  ...over,
});

describe('templates', () => {
  it('ships templates for every fixer that needs one', () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThan(10);
  });

  it('renders every template without leftover placeholders by default', () => {
    for (const name of listTemplates()) {
      const output = render(name);
      expect(output.length, name).toBeGreaterThan(0);
      // Every `<<NAME>>` sentinel must be substituted. An unresolved one would
      // be written into the user's repository as literal text.
      expect(output, name).not.toMatch(/<<[A-Z_]+>>/);
    }
  });

  it('substitutes project-type variables', () => {
    const output = render('Dockerfile.python.tmpl', { PROJECT_TYPE: 'fastapi' });
    expect(output).toContain('uvicorn');
  });

  it('produces balanced TypeScript', () => {
    for (const name of listTemplates().filter((n) => n.endsWith('.ts.tmpl'))) {
      const output = render(name);
      // Balanced braces catch the common failure mode of an escaping mistake
      // truncating a template mid-file.
      const open = (output.match(/\{/g) ?? []).length;
      const close = (output.match(/\}/g) ?? []).length;
      expect(open, name).toBe(close);
    }
  });

  it('generates a workflow with no unescaped GitHub expressions', () => {
    const ci = render('ci.yml.tmpl');
    expect(ci).toContain('${{ github.workflow }}');
    expect(ci).toContain('shipready scan');
    // The YAML must not contain a stray backslash before an expression.
    expect(ci).not.toContain('\\${{');
  });
});

describe('fixer catalogue', () => {
  it('covers the ten highest-value generated fixes', () => {
    const ids = Object.keys(FIXABLE_RULES);
    for (const expected of [
      'readiness/error-handling/no-global-handler',
      'readiness/observability/no-health-check',
      'readiness/deployment/no-env-example',
      'readiness/deployment/no-dockerfile',
      'readiness/security/no-rate-limiting',
      'readiness/security/no-input-validation',
      'readiness/observability/no-structured-logging',
      'readiness/error-handling/console-error-only',
      'readiness/deployment/no-ci',
      'readiness/security/missing-security-headers',
    ]) {
      expect(ids, expected).toContain(expected);
    }
  });

  it('gives every fixer a title and description', () => {
    for (const [id, fixer] of Object.entries(FIXABLE_RULES)) {
      expect(fixer.title.length, id).toBeGreaterThan(5);
      expect(fixer.description.length, id).toBeGreaterThan(20);
    }
  });
});

describe('planFixes', () => {
  const ctx = {
    projectType: 'nextjs',
    frameworks: ['nextjs', 'prisma'],
    envVars: ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'NEXT_PUBLIC_SITE_NAME'],
    routes: ['app/api/x/route.ts'],
  };

  const finding = (ruleId: string, fixable = true) =>
    ({
      id: `id-${ruleId}`,
      ruleId,
      title: 't',
      description: 'd',
      severity: 'high',
      confidence: 0.9,
      category: 'security',
      location: { path: 'a.ts', startLine: 1 },
      evidence: { summary: 'e' },
      remediation: 'r',
      compliance: [],
      productionImpact: 'blocker',
      tags: [],
      fixable,
      effortMinutes: 30,
      references: [],
      source: 'readiness',
    }) as never;

  it('produces nothing for an empty finding list', () => {
    expect(planFixes([], ctx).fixes).toHaveLength(0);
  });

  it('skips findings that are not marked fixable', () => {
    const result = planFixes([finding('readiness/security/no-rate-limiting', false)], ctx);
    expect(result.fixes).toHaveLength(0);
  });

  it('reports a fixable finding with no generator as unsupported', () => {
    const result = planFixes([finding('readiness/security/eval-usage')], ctx);
    expect(result.fixes).toHaveLength(0);
    expect(result.unsupportedFixable).toHaveLength(1);
  });

  it('generates at most one fix per rule, however many occurrences', () => {
    const findings = [finding('readiness/security/no-rate-limiting'), finding('readiness/security/no-rate-limiting')];
    const result = planFixes(findings, ctx);
    const rateLimitFiles = result.fixes.filter((f) => f.ruleId === 'readiness/security/no-rate-limiting');
    expect(rateLimitFiles).toHaveLength(1);
  });

  it('groups .env.example variables by purpose', () => {
    const result = planFixes([finding('readiness/deployment/no-env-example')], ctx);
    const envFix = result.fixes.find((f) => f.path === '.env.example');
    expect(envFix).toBeDefined();
    expect(envFix!.content).toContain('# --- Database ---');
    expect(envFix!.content).toContain('# --- Secrets ---');
    expect(envFix!.content).toContain('DATABASE_URL=');
    // Never write a value into an example file.
    expect(envFix!.content).not.toContain('user:pass');
  });

  it('produces a Dockerfile and a .dockerignore together', () => {
    const result = planFixes([finding('readiness/deployment/no-dockerfile')], ctx);
    const paths = result.fixes.map((f) => f.path);
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('.dockerignore');
  });

  it('chooses the Python variants for a FastAPI project', () => {
    const result = planFixes([finding('readiness/deployment/no-dockerfile')], {
      ...ctx,
      projectType: 'fastapi',
    });
    const dockerfile = result.fixes.find((f) => f.path === 'Dockerfile');
    expect(dockerfile!.content).toContain('uvicorn');
  });

  it('marks every generated file as requiring review', () => {
    const result = planFixes([finding('readiness/observability/no-health-check')], ctx);
    for (const f of result.fixes) expect(f.requiresReview, f.path).toBe(true);
  });

  it('honours the limit on how many rules produce fixes', () => {
    const rules = Object.keys(FIXABLE_RULES).map((r) => finding(r));
    const result = planFixes(rules, ctx, 2);
    expect(result.fixes.length).toBeLessThanOrEqual(4);
  });
});

describe('applyFixes', () => {
  it('writes nothing in dry-run mode', async () => {
    await withTempDir(async (dir) => {
      const result = await applyFixes([fix({ path: 'src/new.ts' })], { dryRun: true, root: dir });
      expect(result.written).toHaveLength(1);
      await expect(readFile(join(dir, 'src/new.ts'), 'utf8')).rejects.toThrow();
    });
  });

  it('creates a file, making parent directories as needed', async () => {
    await withTempDir(async (dir) => {
      const result = await applyFixes([fix({ path: 'deep/nested/new.ts' })], { root: dir });
      expect(result.failed).toHaveLength(0);
      expect(await readFile(join(dir, 'deep/nested/new.ts'), 'utf8')).toBe('export const x = 1;\n');
    });
  });

  it('applies a patch when the anchor is unique', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'app.ts'), "app.get('/', h);\napp.listen(3000);\n", 'utf8');
      const result = await applyFixes(
        [
          fix({
            path: 'app.ts',
            kind: 'patch',
            content: undefined,
            find: 'app.listen(3000);',
            replace: 'app.use(errorHandler);\napp.listen(3000);',
          }),
        ],
        { root: dir },
      );
      expect(result.failed).toHaveLength(0);
      const content = await readFile(join(dir, 'app.ts'), 'utf8');
      expect(content).toContain('app.use(errorHandler);');
    });
  });

  it('refuses to patch when the anchor is ambiguous', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'app.ts'), 'x();\nx();\n', 'utf8');
      const result = await applyFixes(
        [fix({ path: 'app.ts', kind: 'patch', find: 'x();', replace: 'y();' })],
        { root: dir },
      );
      expect(result.written).toHaveLength(0);
      expect(result.failed[0]?.reason).toMatch(/found 2 times/);
      expect(await readFile(join(dir, 'app.ts'), 'utf8')).toBe('x();\nx();\n');
    });
  });

  it('refuses to patch when the anchor is missing', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'app.ts'), 'unrelated();\n', 'utf8');
      const result = await applyFixes(
        [fix({ path: 'app.ts', kind: 'patch', find: 'app.listen(', replace: 'x' })],
        { root: dir },
      );
      expect(result.failed[0]?.reason).toMatch(/not found/);
      expect(await readFile(join(dir, 'app.ts'), 'utf8')).toBe('unrelated();\n');
    });
  });

  it('refuses to patch a file that does not exist', async () => {
    await withTempDir(async (dir) => {
      const result = await applyFixes(
        [fix({ path: 'missing.ts', kind: 'patch', find: 'a', replace: 'b' })],
        { root: dir },
      );
      expect(result.skipped[0]?.reason).toMatch(/does not exist/);
    });
  });

  it('refuses to mix create and patch on one file', async () => {
    await withTempDir(async (dir) => {
      const result = await applyFixes(
        [
          fix({ path: 'app.ts', kind: 'create', ruleId: 'r/a' }),
          fix({ path: 'app.ts', kind: 'patch', ruleId: 'r/b', find: 'a', replace: 'b' }),
        ],
        { root: dir },
      );
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toMatch(/mix/);
    });
  });

  it('combines two creates for the same file rather than racing them', async () => {
    await withTempDir(async (dir) => {
      await applyFixes(
        [
          fix({ path: 'app.ts', kind: 'create', ruleId: 'r/a', content: 'a\n' }),
          fix({ path: 'app.ts', kind: 'create', ruleId: 'r/b', content: 'b\n' }),
        ],
        { root: dir },
      );
      const content = await readFile(join(dir, 'app.ts'), 'utf8');
      expect(content).toBe('a\n\nb\n');
    });
  });

  it('reports a write failure without throwing', async () => {
    await withTempDir(async (dir) => {
      // A directory where a file should be makes the write fail.
      await mkdir(join(dir, 'blocked'), { recursive: true });
      const result = await applyFixes([fix({ path: 'blocked' })], { root: dir });
      expect(result.written).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });
  });

  it('applies a real generated fix end to end', async () => {
    const root = await makeRepo({
      name: 'fixable',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"express":"4.19.2"}}' },
        { path: 'src/index.js', content: "const express = require('express');\nconst app = express();\napp.listen(3000);\n" },
      ],
    });
    try {
      const result = planFixes(
        [
          {
            id: '1',
            ruleId: 'readiness/error-handling/no-global-handler',
            title: 't',
            description: 'd',
            severity: 'high',
            confidence: 0.9,
            category: 'error-handling',
            location: { path: 'src/index.js', startLine: 1 },
            evidence: { summary: 'e' },
            remediation: 'r',
            compliance: [],
            productionImpact: 'blocker',
            tags: [],
            fixable: true,
            effortMinutes: 60,
            references: [],
            source: 'readiness',
          } as never,
        ],
        { projectType: 'express', frameworks: ['express'], envVars: [], routes: [] },
      );

      expect(result.fixes.length).toBeGreaterThan(0);
      const applied = await applyFixes(result.fixes, { root });
      expect(applied.failed).toHaveLength(0);
      const middlewarePath = join(root, 'src/middleware/error-handler.ts');
      const generated = await readFile(middlewarePath, 'utf8');
      expect(generated).toContain('export function errorHandler');
      // The generated middleware must be commented about review.
      expect(result.fixes.every((f) => f.requiresReview)).toBe(true);
    } finally {
      await removeRepo(root);
    }
  });
});