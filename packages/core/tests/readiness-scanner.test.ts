import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScan } from '../src/engine.js';
import { createDefaultRegistry } from '../src/index.js';
import type { Finding, ProductionReadinessReport } from '../src/types.js';
import { FIXTURES, makeRepo, removeRepo } from './fixtures.js';

/**
 * End-to-end scanner tests against the two fixture repositories.
 *
 * The contract these tests enforce is the one that matters: a rule that fires
 * on the vulnerable fixture and stays silent on the production-ready one is a
 * true positive. A rule that fires on both is a false positive, and a false
 * positive is more expensive than a miss -- it teaches people to ignore the
 * tool.
 */

let vulnerableRoot: string;
let readyRoot: string;
let vulnerable: ProductionReadinessReport;
let ready: ProductionReadinessReport;

async function scan(root: string): Promise<ProductionReadinessReport> {
  const { report } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
  return report;
}

function ruleIds(report: ProductionReadinessReport): Set<string> {
  return new Set(report.findings.map((f) => f.ruleId));
}

function findingsFor(report: ProductionReadinessReport, ruleId: string): Finding[] {
  return report.findings.filter((f) => f.ruleId === ruleId);
}

beforeAll(async () => {
  vulnerableRoot = await makeRepo(FIXTURES.vulnerable);
  readyRoot = await makeRepo(FIXTURES.productionReady);
  vulnerable = await scan(vulnerableRoot);
  ready = await scan(readyRoot);
}, 120_000);

afterAll(async () => {
  await removeRepo(vulnerableRoot);
  await removeRepo(readyRoot);
});

describe('the scanner distinguishes the two fixtures', () => {
  it('detects both as the same project type', () => {
    expect(vulnerable.project.type).toBe('nextjs');
    expect(ready.project.type).toBe('nextjs');
  });

  it('scores the production-ready fixture materially higher', () => {
    expect(ready.score).toBeGreaterThan(vulnerable.score + 20);
  });

  it('gives different verdicts', () => {
    expect(vulnerable.verdict).toBe('NOT READY');
    expect(ready.verdict).not.toBe('NOT READY');
  });

  it('counts lines in both', () => {
    expect(vulnerable.project.totalLines).toBeGreaterThan(50);
    expect(ready.project.totalLines).toBeGreaterThan(300);
  });
});

describe('error handling checks', () => {
  const ids = ['readiness/error-handling/no-global-handler', 'readiness/error-handling/no-error-boundary', 'readiness/error-handling/empty-catch'];

  it('fires on the vulnerable fixture', () => {
    const fired = ruleIds(vulnerable);
    for (const id of ids) expect(fired.has(id), id).toBe(true);
  });

  it('does not fire on the production-ready fixture', () => {
    const fired = ruleIds(ready);
    for (const id of ids) expect(fired.has(id), `${id} should not fire`).toBe(false);
  });

  it('explains an empty catch precisely', () => {
    const finding = findingsFor(vulnerable, 'readiness/error-handling/empty-catch')[0];
    expect(finding).toBeDefined();
    expect(finding!.evidence.summary).toMatch(/discards the error/i);
    expect(finding!.location.startLine).toBeGreaterThan(0);
  });

  it('reports the bare except in python', async () => {
    const root = await makeRepo({
      name: 'py',
      files: [
        { path: 'pyproject.toml', content: '[project]\nname = "svc"\ndependencies = ["fastapi"]\n' },
        { path: 'main.py', content: 'def run():\n    try:\n        pass\n    except:\n        pass\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(ruleIds(report).has('readiness/error-handling/bare-except')).toBe(true);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('security checks', () => {
  it('flags missing rate limiting on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/security/no-rate-limiting')).toBe(true);
    expect(ruleIds(ready).has('readiness/security/no-rate-limiting')).toBe(false);
  });

  it('flags unvalidated input on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/security/no-input-validation')).toBe(true);
    expect(ruleIds(ready).has('readiness/security/no-input-validation')).toBe(false);
  });

  it('flags missing security headers on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/security/missing-security-headers')).toBe(true);
    expect(ruleIds(ready).has('readiness/security/missing-security-headers')).toBe(false);
  });

  it('detects a hardcoded AWS key and redacts it in the report', async () => {
    // A realistic key shape. Note that `AKIAIOSFODNN7EXAMPLE` -- AWS's own
    // documentation key -- is deliberately *not* reported: a placeholder that
    // trips the scanner is a placeholder people stop believing.
    const root = await makeRepo({
      name: 'secret',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"express":"4.19.2"}}' },
        { path: 'src/config.js', content: 'const id = "AKIA4T7RQZK2MXWPLB9D";\nexport default { id };\n' },
      ],
    });
    try {
      const report = await scan(root);
      const found = findingsFor(report, 'readiness/deployment/hardcoded-secrets');
      expect(found).toHaveLength(1);
      // The report must not reprint the credential.
      const serialised = JSON.stringify(report);
      expect(serialised).not.toContain('AKIA4T7RQZK2MXWPLB9D');
      expect(found[0]!.evidence.summary).toContain('redacted');
    } finally {
      await removeRepo(root);
    }
  });

  it('does not treat a placeholder as a leaked secret', async () => {
    const root = await makeRepo({
      name: 'placeholder',
      files: [
        { path: 'package.json', content: '{"name":"x"}' },
        { path: 'src/config.js', content: 'const key = "sk-your-key-here-replace-me";\n' },
        // AWS's documented example key must not be reported either.
        { path: 'src/other.js', content: 'const id = "AKIAIOSFODNN7EXAMPLE";\n' },
        // A .env.example with an example database URL is the correct thing to commit.
        { path: '.env.example', content: '# Database\nDATABASE_URL="postgresql://user:pass@localhost:5432/app"\n\n# Secrets\nSTRIPE_SECRET_KEY=\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/deployment/hardcoded-secrets')).toHaveLength(0);
    } finally {
      await removeRepo(root);
    }
  });

  it('detects a wildcard CORS origin as critical', async () => {
    const root = await makeRepo({
      name: 'cors',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"express":"4.19.2"}}' },
        { path: 'src/app.js', content: "app.use(cors({ origin: '*', credentials: true }));\n" },
      ],
    });
    try {
      const report = await scan(root);
      const found = findingsFor(report, 'readiness/security/wildcard-cors');
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe('critical');
    } finally {
      await removeRepo(root);
    }
  });

  it('detects SQL built by interpolation', async () => {
    const root = await makeRepo({
      name: 'sql',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"pg":"8.11.0"}}' },
        { path: 'src/users.js', content: 'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/security/sql-interpolation')).toHaveLength(1);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('database checks', () => {
  it('flags a missing migration system on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/database/no-migration-system')).toBe(true);
    expect(ruleIds(ready).has('readiness/database/no-migration-system')).toBe(false);
  });

  /**
   * False positives, each of which shipped and was caught by scanning a real
   * open-source library. They are worth pinning because the failure mode is
   * silent: the report is confident, the paths are real, and every finding is
   * wrong.
   */
  describe('does not mistake ordinary code for database code', () => {
    /** A library with no database anywhere, and no ORM dependency. */
    async function scanLibrary(files: { path: string; content: string }[]): Promise<ProductionReadinessReport> {
      const root = await makeRepo({
        name: 'lib',
        files: [{ path: 'package.json', content: '{"name":"lib","dependencies":{"zod":"3.0.0"}}' }, ...files],
      });
      try {
        return await scan(root);
      } finally {
        await removeRepo(root);
      }
    }

    it('does not report N+1 for a schema walker that calls .create() in a loop', async () => {
      // This is zod's `deepPartialify`, near enough. `ZodOptional.create(...)`
      // inside a `for...in` is not a database round trip.
      const report = await scanLibrary([
        {
          path: 'src/walker.ts',
          content: [
            'export function partialify(schema: any): any {',
            '  const shape: any = {};',
            '  for (const key in schema.shape) {',
            '    shape[key] = Optional.create(partialify(schema.shape[key]));',
            '  }',
            '  return new ZodObject(shape);',
            '}',
          ].join('\n'),
        },
      ]);

      expect(findingsFor(report, 'readiness/database/n-plus-one')).toHaveLength(0);
      expect(findingsFor(report, 'readiness/database/unbounded-query')).toHaveLength(0);
      expect(findingsFor(report, 'readiness/database/no-transaction')).toHaveLength(0);
    });

    it('does not treat prose about ORMs as evidence of a database', async () => {
      // A docs page that links to drizzle-zod, and a README that mentions
      // DATABASE_URL, are the two most common ways a library looks like a
      // database service. Both are text, not code.
      const report = await scanLibrary([
        {
          path: 'docs/ecosystem.md',
          content: 'Works with drizzle-zod, @prisma/client, sequelize and mongoose. Set DATABASE_URL first.',
        },
        { path: 'README.md', content: 'Run with DATABASE_URL=postgres://localhost/app' },
      ]);

      expect(ruleIds(report).has('readiness/database/no-migration-system')).toBe(false);
      expect(ruleIds(report).has('readiness/database/no-connection-pooling')).toBe(false);
    });

    it('does not treat a .pg namespace call as the pg driver', async () => {
      // `pg.` is a namespace on a plugin object here, not the node-postgres
      // client. A bare `\bpg\b` matched it and unlocked every database rule.
      const report = await scanLibrary([
        { path: 'src/plugin.ts', content: ['export class P {', '  pg = { load: (n: string) => n };', '}'].join('\n') },
      ]);

      expect(ruleIds(report).has('readiness/database/no-migration-system')).toBe(false);
    });

    it('does not read its own saved report as evidence', async () => {
      // Each saved report quotes the remediation text, which names DATABASE_URL
      // and Prisma. Scanning a repo ShipReady had already scanned made the next
      // run believe that repo used a database.
      const report = await scanLibrary([
        {
          path: '.shipready/last-scan.json',
          content: JSON.stringify({
            findings: [
              {
                ruleId: 'readiness/database/no-migration-system',
                remediation: 'Adopt prisma migrate or set DATABASE_URL.',
              },
            ],
          }),
        },
      ]);

      expect(ruleIds(report).has('readiness/database/no-migration-system')).toBe(false);
      expect(ruleIds(report).has('readiness/database/no-connection-pooling')).toBe(false);
    });

    it('does not scan agent instruction files for code smells', async () => {
      // `.claude/skills/*/SKILL.md` describes SQL and migrations in prose, and
      // prose about databases reads exactly like code that uses one.
      const report = await scanLibrary([
        {
          path: '.claude/skills/security-advisory/SKILL.md',
          content:
            'If the app uses a SQL database with no migrations, use `prisma migrate`. See `DATABASE_URL` and pool settings.',
        },
      ]);

      expect(ruleIds(report).has('readiness/database/no-migration-system')).toBe(false);
      expect(ruleIds(report).has('readiness/database/no-connection-pooling')).toBe(false);
    });
  });

  it('still detects N+1 through a global Prisma client with no import', async () => {
    // The tightening must not cost real detections. This is the common way a
    // Prisma project is written: the client is a singleton, not an import.
    const root = await makeRepo({
      name: 'globalclient',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"@prisma/client":"5.0.0"}}' },
        {
          path: 'src/report.ts',
          content: [
            'export async function build(userIds: string[]) {',
            '  const out = [];',
            '  for (const id of userIds) {',
            '    out.push(await prisma.user.findUnique({ where: { id } }));',
            '  }',
            '  return out;',
            '}',
          ].join('\n'),
        },
      ],
    });
    try {
      expect(findingsFor(await scan(root), 'readiness/database/n-plus-one').length).toBeGreaterThan(0);
    } finally {
      await removeRepo(root);
    }
  });

  it('does not report an indexed foreign key', () => {
    // The production-ready schema declares @@index on every relation column.
    expect(findingsFor(ready, 'readiness/database/missing-foreign-key-index')).toHaveLength(0);
  });

  it('reports an unindexed foreign key in the vulnerable schema', () => {
    const found = findingsFor(vulnerable, 'readiness/database/missing-foreign-key-index');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.evidence.summary).toMatch(/foreign key/);
  });

  it('detects an N+1 query inside a loop', async () => {
    const root = await makeRepo({
      name: 'nplusone',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"@prisma/client":"5.0.0"}}' },
        {
          path: 'src/report.ts',
          content: [
            'export async function build(userIds: string[]) {',
            '  const out = [];',
            '  for (const id of userIds) {',
            '    const user = await prisma.user.findUnique({ where: { id } });',
            '    out.push(user);',
            '  }',
            '  return out;',
            '}',
          ].join('\n'),
        },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/database/n-plus-one').length).toBeGreaterThan(0);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('observability checks', () => {
  it('flags a missing health check on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/observability/no-health-check')).toBe(true);
    expect(ruleIds(ready).has('readiness/observability/no-health-check')).toBe(false);
  });

  it('accepts a Next.js app/api/health route file', async () => {
    const root = await makeRepo({
      name: 'next-health',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"next":"14.0.0","react":"18.0.0"}}' },
        { path: 'app/api/health/route.ts', content: 'export function GET() { return Response.json({ status: "ok" }); }\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(ruleIds(report).has('readiness/observability/no-health-check')).toBe(false);
    } finally {
      await removeRepo(root);
    }
  });

  it('flags personal data in logs', async () => {
    const root = await makeRepo({
      name: 'pii',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"express":"4.19.2"}}' },
        { path: 'src/signup.js', content: "console.log('signup', { email, password });\n" },
      ],
    });
    try {
      const report = await scan(root);
      const found = findingsFor(report, 'readiness/observability/potential-pii-in-logs');
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]!.evidence.summary).toMatch(/personal data/i);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('deployment checks', () => {
  it('flags a missing Dockerfile and CI on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/deployment/no-dockerfile')).toBe(true);
    expect(ruleIds(ready).has('readiness/deployment/no-dockerfile')).toBe(false);
    expect(ruleIds(vulnerable).has('readiness/deployment/no-ci')).toBe(true);
    expect(ruleIds(ready).has('readiness/deployment/no-ci')).toBe(false);
  });

  it('flags a missing .env.example only where env vars are used', () => {
    expect(ruleIds(vulnerable).has('readiness/deployment/no-env-example')).toBe(true);
    expect(ruleIds(ready).has('readiness/deployment/no-env-example')).toBe(false);
  });
});

describe('testing checks', () => {
  it('flags a complete absence of tests on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/testing/no-tests')).toBe(true);
    expect(ruleIds(ready).has('readiness/testing/no-tests')).toBe(false);
  });

  it('does not demand e2e tests once Playwright is present', () => {
    expect(ruleIds(ready).has('readiness/testing/no-e2e-tests')).toBe(false);
  });

  it('flags CI that never runs the tests', async () => {
    const root = await makeRepo({
      name: 'ci-no-tests',
      files: [
        { path: 'package.json', content: '{"name":"x","scripts":{"test":"jest"}}' },
        { path: 'src/a.test.js', content: "test('a', () => expect(1).toBe(1));\n" },
        { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm run build\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(ruleIds(report).has('readiness/testing/no-tests-in-ci')).toBe(true);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('accessibility checks', () => {
  it('flags missing alt text on the vulnerable fixture only', () => {
    expect(ruleIds(vulnerable).has('readiness/accessibility/missing-alt-text')).toBe(true);
    expect(ruleIds(ready).has('readiness/accessibility/missing-alt-text')).toBe(false);
  });

  it('flags an icon-only button with no accessible name', () => {
    expect(ruleIds(vulnerable).has('readiness/accessibility/missing-aria-label')).toBe(true);
    expect(ruleIds(ready).has('readiness/accessibility/missing-aria-label')).toBe(false);
  });

  it('flags a click handler on a non-interactive element', () => {
    expect(ruleIds(vulnerable).has('readiness/accessibility/non-semantic-interaction')).toBe(true);
    expect(ruleIds(ready).has('readiness/accessibility/non-semantic-interaction')).toBe(false);
  });

  it('flags outline:none without a focus-visible replacement', () => {
    expect(ruleIds(vulnerable).has('readiness/accessibility/no-focus-styles')).toBe(true);
    expect(ruleIds(ready).has('readiness/accessibility/no-focus-styles')).toBe(false);
  });

  it('accepts a decorative image with alt=""', async () => {
    const root = await makeRepo({
      name: 'alt-ok',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"next":"14.0.0","react":"18.0.0"}}' },
        { path: 'app/page.tsx', content: 'export default function P() { return <img src="/spacer.gif" alt="" />; }\n' },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/accessibility/missing-alt-text')).toHaveLength(0);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('AI-specific checks', () => {
  it('flags missing token limits, cost tracking and output validation on the vulnerable fixture', () => {
    const fired = ruleIds(vulnerable);
    for (const id of [
      'readiness/ai-specific/no-token-limits',
      'readiness/ai-specific/no-cost-tracking',
      'readiness/ai-specific/no-output-validation',
      'readiness/ai-specific/no-eval-suite',
      'readiness/ai-specific/no-prompt-injection-guard',
    ]) {
      expect(fired.has(id), id).toBe(true);
    }
  });

  it('does not fire on those checks for the production-ready fixture', () => {
    const fired = ruleIds(ready);
    for (const id of [
      'readiness/ai-specific/no-token-limits',
      'readiness/ai-specific/no-cost-tracking',
      'readiness/ai-specific/no-output-validation',
      'readiness/ai-specific/no-eval-suite',
    ]) {
      expect(fired.has(id), `${id} should not fire`).toBe(false);
    }
  });

  it('treats a model call with no max_tokens as a launch blocker', async () => {
    const root = await makeRepo({
      name: 'llm',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"openai":"4.55.0"}}' },
        {
          path: 'src/llm.ts',
          content: [
            "import OpenAI from 'openai';",
            'const openai = new OpenAI();',
            'export async function run(input: string) {',
            '  return openai.chat.completions.create({',
            '    model: "gpt-4",',
            '    messages: [{ role: "user", content: input }],',
            '  });',
            '}',
          ].join('\n'),
        },
      ],
    });
    try {
      const report = await scan(root);
      const finding = findingsFor(report, 'readiness/ai-specific/no-token-limits')[0];
      expect(finding).toBeDefined();
      expect(finding!.productionImpact).toBe('blocker');
      expect(finding!.evidence.summary).toMatch(/max_tokens|quota/i);
    } finally {
      await removeRepo(root);
    }
  });

  it('is satisfied only when both a per-request cap and a quota exist', async () => {
    // A per-request cap alone is not enough: it bounds one call, not one user.
    const cappedOnly = await makeRepo({
      name: 'llm-ok',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"openai":"4.55.0"}}' },
        {
          path: 'src/llm.ts',
          content: [
            "import OpenAI from 'openai';",
            'const openai = new OpenAI({ timeout: 30_000 });',
            'export async function run(input: string) {',
            '  return openai.chat.completions.create({',
            '    model: "gpt-4o-mini",',
            '    max_tokens: 1024,',
            '    messages: [{ role: "user", content: input }],',
            '  });',
            '}',
          ].join('\n'),
        },
      ],
    });
    try {
      const report = await scan(cappedOnly);
      const found = findingsFor(report, 'readiness/ai-specific/no-token-limits');
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence.summary).toMatch(/no per-user quota/i);
    } finally {
      await removeRepo(cappedOnly);
    }

    // Cap plus a quota is a complete answer.
    const both = await makeRepo({
      name: 'llm-complete',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"openai":"4.55.0"}}' },
        {
          path: 'src/quota.ts',
          content: 'export async function consumeQuota(userId: string) { return db.quota.consume({ userId }); }\n',
        },
        {
          path: 'src/llm.ts',
          content: [
            "import OpenAI from 'openai';",
            'const openai = new OpenAI({ timeout: 30_000 });',
            'export async function run(input: string) {',
            '  return openai.chat.completions.create({',
            '    model: "gpt-4o-mini",',
            '    max_tokens: 1024,',
            '    messages: [{ role: "user", content: input }],',
            '  });',
            '}',
          ].join('\n'),
        },
      ],
    });
    try {
      const report = await scan(both);
      expect(findingsFor(report, 'readiness/ai-specific/no-token-limits')).toHaveLength(0);
    } finally {
      await removeRepo(both);
    }
  });
});

describe('AI-security checks', () => {
  it('flags a database client imported into client code', async () => {
    const root = await makeRepo({
      name: 'client-db',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"next":"14.0.0","react":"18.0.0","@prisma/client":"5.0.0"}}' },
        { path: 'components/Users.tsx', content: "import { prisma } from '@prisma/client';\nexport const U = () => <div>{prisma.user.count()}</div>;\n" },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'ai-security/client-db-access')).toHaveLength(1);
    } finally {
      await removeRepo(root);
    }
  });

  it('flags an MCP server with no authentication', async () => {
    const root = await makeRepo({
      name: 'mcp',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"@modelcontextprotocol/sdk":"1.0.0"}}' },
        {
          path: 'src/mcp.ts',
          content: [
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
            'const server = new McpServer({ name: "files" });',
            'server.tool("read", async () => "ok");',
            'server.listen(3001);',
          ].join('\n'),
        },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'ai-security/mcp-no-auth').length).toBeGreaterThan(0);
    } finally {
      await removeRepo(root);
    }
  });

  it('accepts a Next.js route protected by middleware', async () => {
    const root = await makeRepo({
      name: 'mw-auth',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"next":"14.0.0","react":"18.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' },
        { path: 'middleware.ts', content: "export function middleware(req: NextRequest) {\n  if (!req.cookies.get('session')) return new NextResponse(null, { status: 401 });\n  return NextResponse.next();\n}\n" },
        { path: 'app/api/data/route.ts', content: "export async function GET() { return Response.json(await prisma.user.findMany()); }\n" },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/security/no-auth-on-api-route')).toHaveLength(0);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('data integrity checks', () => {
  it('flags missing audit trail and soft delete on the vulnerable fixture', () => {
    const fired = ruleIds(vulnerable);
    expect(fired.has('readiness/data-integrity/no-audit-trail')).toBe(true);
    expect(fired.has('readiness/data-integrity/hard-delete-user-data')).toBe(true);
  });

  it('accepts a documented backup strategy', () => {
    expect(findingsFor(ready, 'readiness/data-integrity/no-backup-strategy')).toHaveLength(0);
  });

  it('flags a payment path with no idempotency key', async () => {
    const root = await makeRepo({
      name: 'payments',
      files: [
        { path: 'package.json', content: '{"name":"x","dependencies":{"stripe":"16.0.0"}}' },
        {
          path: 'src/pay.ts',
          content: "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\nexport const charge = async (amount: number) => stripe.paymentIntents.create({ amount, currency: 'usd' });\n",
        },
      ],
    });
    try {
      const report = await scan(root);
      expect(findingsFor(report, 'readiness/data-integrity/payment-without-idempotency').length).toBeGreaterThan(0);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('report integrity', () => {
  it('gives every finding a stable id and a usable location', () => {
    for (const report of [vulnerable, ready]) {
      for (const finding of report.findings) {
        expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
        expect(finding.location.path).not.toBe('');
        expect(finding.location.startLine).toBeGreaterThanOrEqual(1);
        expect(finding.confidence).toBeGreaterThan(0);
        expect(finding.confidence).toBeLessThanOrEqual(1);
        expect(finding.remediation.length).toBeGreaterThan(10);
      }
    }
  });

  it('never emits duplicate finding ids', () => {
    for (const report of [vulnerable, ready]) {
      const ids = report.findings.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('attaches compliance mappings to every finding that needs one', () => {
    for (const report of [vulnerable, ready]) {
      for (const finding of report.findings) {
        if (['performance', 'accessibility'].includes(finding.category)) continue;
        expect(finding.compliance.length, `${finding.ruleId} needs a mapping`).toBeGreaterThan(0);
      }
    }
  });

  it('lists at most five top blockers, worst first', () => {
    for (const report of [vulnerable, ready]) {
      expect(report.topBlockers.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < report.topBlockers.length; i++) {
        expect(SEVERITY_RANK[report.topBlockers[i]!.severity] ?? 0).toBeLessThanOrEqual(
          SEVERITY_RANK[report.topBlockers[i - 1]!.severity] ?? 0,
        );
      }
    }
  });

  it('estimates time to launch from the blockers only', () => {
    expect(vulnerable.summary.estimatedMinutesToLaunch).toBeGreaterThan(0);
    expect(vulnerable.summary.estimatedTimeToLaunch).not.toBe('');
  });

  it('is deterministic across runs', async () => {
    const again = await scan(vulnerableRoot);
    expect(again.score).toBe(vulnerable.score);
    expect(again.findings.map((f) => f.id)).toEqual(vulnerable.findings.map((f) => f.id));
  });

  it('marks top blockers with an auto-fix plan when one exists', () => {
    const fixable = vulnerable.topBlockers.filter((b) => b.autoFix);
    expect(fixable.length).toBeGreaterThan(0);
    for (const blocker of fixable) {
      expect(blocker.autoFix!.ruleId).toBe(blocker.ruleId);
    }
  });
});

const SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };