import type { Finding, ProductionImpact, Severity } from '../types.js';
import type { EmitInput, RuleMeta } from '../rules/rule.js';
import { render } from './templates.js';

/**
 * Auto-fixers for the highest-value generated fixes.
 *
 * Scope is deliberately narrow. Every fixer produces something a competent
 * engineer could have written in the time the report estimated: a real Express
 * error middleware, a real health check with a real dependency probe, a real
 * `.env.example` derived from the variables your code actually reads.
 *
 * None of them attempt a clever refactor. Everything is marked
 * `requiresReview`, because generating a file into someone's repository
 * without them reading the diff is the fastest way to lose their trust.
 *
 * What we refuse to generate: anything that changes application behaviour in a
 * way a human has to reason about to verify. A rate limiter with the wrong
 * numbers, or validation that rejects valid input, is worse than no limit at
 * all -- it fails silently, and nobody notices.
 */

export interface FileFix {
  ruleId: string;
  title: string;
  description: string;
  path: string;
  kind: 'create' | 'patch' | 'append';
  content?: string;
  /** For `patch`: exact text to find (must be unique) and its replacement. */
  find?: string;
  replace?: string;
  requiresReview: boolean;
  category: string;
  severity: Severity;
}

export interface FixContext {
  finding: Finding;
  projectType: string;
  frameworks: string[];
  serverFile?: string;
  /** Variables the code actually reads. */
  envVars: string[];
  routes: string[];
  testsDir?: string;
}

export interface FixPlanResult {
  fixes: FileFix[];
  /** Findings that claim `fixable` but have no generator. */
  unsupportedFixable: Finding[];
}

interface Fixer {
  title: string;
  description: string;
  requiresReview: boolean;
  build(ctx: FixContext): FileFix[] | null;
}

const isPython = (ctx: FixContext): boolean => ['fastapi', 'django', 'python'].includes(ctx.projectType);
const hasDb = (ctx: FixContext): boolean =>
  ctx.frameworks.some((f) => ['prisma', 'drizzle-orm', 'django', 'sqlalchemy'].includes(f));

export const FIXABLE_RULES: Readonly<Record<string, Fixer>> = Object.freeze({
  'readiness/error-handling/no-global-handler': {
    title: 'Generate global error middleware',
    description: 'Creates Express error middleware with a request id and safe client responses.',
    requiresReview: true,
    build(ctx) {
      if (isPython(ctx)) {
        return [
          fix(ctx, {
            path: 'app/main.py',
            kind: 'patch',
            find: 'app = FastMQ(',
            replace: [
              'app = FastMQ(',
              '# ShipReady: global exception handling. Register handlers so every',
              '# error gets a log line and a correlation id instead of a bare 500.',
              '@app.exception_handler(Exception)',
              'async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:',
              '    request_id = request.headers.get("x-request-id", str(uuid4()))',
              '    logger.exception("unhandled error", extra={"request_id": request_id})',
              '    return JSONResponse(',
              '        status_code=500,',
              '        content={"error": "internal_error", "requestId": request_id},',
              '    )',
              '',
            ].join('\n'),
          }),
        ];
      }
      return [
        fix(ctx, {
          path: ctx.serverFile && ctx.serverFile.includes('/') ? ctx.serverFile : 'src/middleware/error-handler.ts',
          kind: 'create',
          content: render('express-error-handler.ts.tmpl'),
        }),
        fix(ctx, {
          path: ctx.serverFile && ctx.serverFile.includes('/') ? ctx.serverFile : 'src/app.ts',
          kind: 'patch',
          find: 'app.listen(',
          replace: [
            '// ShipReady: wire up the global error handler. Add to your imports:',
            "//   import { errorHandler, requestId } from './middleware/error-handler';",
            '// app.use(requestId);',
            'app.use((err, req, res, next) => errorHandler(err, req, res, next));',
            'app.listen(',
          ].join('\n'),
        }),
      ];
    },
  },

  'readiness/observability/no-health-check': {
    title: 'Generate health and readiness probes',
    description: 'Creates a liveness endpoint and a readiness endpoint with a real dependency check.',
    requiresReview: true,
    build(ctx) {
      if (isPython(ctx)) {
        return [
          fix(ctx, {
            path: 'app/health.py',
            kind: 'create',
            content: [
              '"""',
              'Liveness and readiness probes.',
              '',
              'Mount these BEFORE authentication so the orchestrator can reach them.',
              'Liveness must NOT check dependencies: if it does, a database blip',
              'restarts every pod and turns an outage into a crash loop.',
              '"""',
              'from uuid import uuid4',
              '',
              'from fastapi import APIRouter, Response, status',
              'from fastapi.responses import JSONResponse',
              '',
              'router = APIRouter(tags=["health"])',
              '',
              '',
              '@router.get("/health")',
              'async def health() -> dict:',
              '    """Liveness: is this process running? No dependency checks here."""',
              '    return {"status": "ok"}',
              '',
              '',
              '@router.get("/health/ready")',
              'async def ready(response: Response) -> JSONResponse:',
              '    """Readiness: can this instance serve traffic right now?"""',
              hasDb(ctx)
                ? [
                    '    try:',
                    '        await database.connect()',
                    '    except Exception as exc:  # noqa: BLE001',
                    '        return JSONResponse(',
                    '            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,',
                    '            content={"status": "degraded", "reason": type(exc).__name__},',
                    '        )',
                    '    return JSONResponse({"status": "ready"})',
                  ].join('\n')
                : '    # No database detected. Add your dependency check here.\n    return JSONResponse({"status": "ready"})',
              '',
              '',
              '# In main.py: app.include_router(router)',
              '',
            ].join('\n'),
          }),
        ];
      }
      return [
        fix(ctx, {
          path: 'src/health.ts',
          kind: 'create',
          content: render('health.ts.tmpl'),
        }),
        fix(ctx, {
          path: 'src/dependencies.ts',
          kind: 'create',
          content: render('dependencies.ts.tmpl'),
        }),
      ];
    },
  },

  'readiness/deployment/no-env-example': {
    title: 'Generate .env.example',
    description: 'Derives .env.example from the environment variables your code actually reads, grouped by purpose.',
    requiresReview: false,
    build(ctx) {
      if (ctx.envVars.length === 0) return [];
      const groups = new Map<string, string[]>();
      for (const v of ctx.envVars) {
        const group = groupFor(v);
        const arr = groups.get(group) ?? [];
        arr.push(v);
        groups.set(group, arr);
      }
      const lines = [
        '# Environment variables',
        '',
        '# Copy to .env and fill in. Never commit the filled-in file.',
        '# Generated by ShipReady from the variables your code actually reads.',
        '',
      ];
      for (const [group, vars] of [...groups.entries()].sort()) {
        lines.push(`# --- ${group} ---`);
        for (const v of vars.sort()) lines.push(`${v}=`);
        lines.push('');
      }
      return [
        fix(ctx, { path: '.env.example', kind: 'create', content: lines.join('\n') }),
        fix(ctx, {
          path: '.gitignore',
          kind: 'patch',
          find: '.env',
          replace: '.env\n!.env.example',
        }),
      ];
    },
  },

  'readiness/deployment/no-dockerfile': {
    title: 'Generate a multi-stage Dockerfile',
    description: 'Creates a multi-stage Dockerfile that builds as root and ships as a non-root user.',
    requiresReview: true,
    build(ctx) {
      const python = isPython(ctx);
      return [
        fix(ctx, {
          path: 'Dockerfile',
          kind: 'create',
          content: render(python ? 'Dockerfile.python.tmpl' : 'Dockerfile.node.tmpl', {
            PROJECT_TYPE: ctx.projectType,
          }),
        }),
        fix(ctx, {
          path: '.dockerignore',
          kind: 'create',
          content: render('dockerignore.tmpl', { TESTS_DIR: ctx.testsDir ?? 'tests' }),
        }),
      ];
    },
  },

  'readiness/security/no-rate-limiting': {
    title: 'Generate rate limiting',
    description: 'Creates rate-limit middleware with a tight tier for model-calling endpoints.',
    requiresReview: true,
    build(ctx) {
      if (isPython(ctx)) {
        return [
          fix(ctx, { path: 'app/middleware/rate_limit.py', kind: 'create', content: render('rate_limit.py.tmpl') }),
        ];
      }
      return [
        fix(ctx, { path: 'src/middleware/rate-limit.ts', kind: 'create', content: render('rate-limit.ts.tmpl') }),
      ];
    },
  },

  'readiness/security/no-input-validation': {
    title: 'Generate a validation layer',
    description: 'Creates Zod schemas with bounded field lengths, so cost and abuse controls live at the boundary.',
    requiresReview: true,
    build(ctx) {
      return [fix(ctx, { path: 'src/validation/schemas.ts', kind: 'create', content: render('schemas.ts.tmpl') })];
    },
  },

  'readiness/observability/no-structured-logging': {
    title: 'Generate a structured logger',
    description: 'Creates a pino (or Python structlog-style) logger with redaction applied before serialisation.',
    requiresReview: false,
    build(ctx) {
      if (isPython(ctx)) {
        return [fix(ctx, { path: 'app/logging_config.py', kind: 'create', content: render('logging_config.py.tmpl') })];
      }
      return [fix(ctx, { path: 'src/lib/logger.ts', kind: 'create', content: render('logger.ts.tmpl') })];
    },
  },

  'readiness/error-handling/console-error-only': {
    title: 'Generate error tracking setup',
    description: 'Creates Sentry initialisation that is imported before any application code.',
    requiresReview: true,
    build(ctx) {
      if (isPython(ctx)) {
        return [fix(ctx, { path: 'app/observability.py', kind: 'create', content: render('observability.py.tmpl') })];
      }
      return [
        fix(ctx, { path: 'src/instrumentation.ts', kind: 'create', content: render('instrumentation.ts.tmpl') }),
      ];
    },
  },

  'readiness/deployment/no-ci': {
    title: 'Generate a CI workflow',
    description: 'Creates a GitHub Actions workflow that lints, typechecks, tests, builds and runs a readiness scan.',
    requiresReview: false,
    build(ctx) {
      return [
        fix(ctx, {
          path: '.github/workflows/ci.yml',
          kind: 'create',
          content: render('ci.yml.tmpl', { PROJECT_TYPE: ctx.projectType }),
        }),
      ];
    },
  },

  'readiness/security/missing-security-headers': {
    title: 'Generate security headers',
    description: 'Creates security response headers, with a CSP that starts in report-only mode.',
    requiresReview: true,
    build(ctx) {
      if (ctx.projectType === 'nextjs') {
        return [
          fix(ctx, { path: 'next.config.js', kind: 'create', content: render('next.config.cjs.tmpl') }),
        ];
      }
      return [
        fix(ctx, {
          path: 'src/middleware/security-headers.ts',
          kind: 'create',
          content: render('security-headers.ts.tmpl'),
        }),
      ];
    },
  },

  'readiness/testing/no-tests': {
    title: 'Generate smoke tests',
    description: 'Creates a smoke suite that fails the build when the app cannot boot at all.',
    requiresReview: false,
    build(ctx) {
      if (isPython(ctx)) {
        return [fix(ctx, { path: 'tests/test_health.py', kind: 'create', content: render('test_health.py.tmpl') })];
      }
      return [fix(ctx, { path: `${ctx.testsDir ?? 'tests'}/smoke.test.ts`, kind: 'create', content: render('smoke.test.ts.tmpl') })];
    },
  },

  'readiness/observability/no-metrics': {
    title: 'Generate Prometheus metrics',
    description: 'Creates a metrics registry including LLM token and cost counters.',
    requiresReview: true,
    build(ctx) {
      if (isPython(ctx)) {
        return [fix(ctx, { path: 'app/metrics.py', kind: 'create', content: render('metrics.py.tmpl') })];
      }
      return [fix(ctx, { path: 'src/metrics.ts', kind: 'create', content: render('metrics.ts.tmpl') })];
    },
  },
});

function groupFor(v: string): string {
  if (/(^|_)(DB|DATABASE|POSTGRES|MYSQL|MONGO|REDIS|SUPABASE)/.test(v)) return 'Database';
  if (/(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|PRIVATE)/.test(v)) return 'Secrets';
  if (/(URL|ORIGIN|HOST|PORT|ENDPOINT)/.test(v)) return 'Network';
  if (/(API|AI|MODEL|OPENAI|ANTHROPIC|LLM)/.test(v)) return 'AI providers';
  if (/(STRIPE|POLAR|LEMONSQUEEZY|PADDLE|RAZORPAY)/.test(v)) return 'Payments';
  if (/(CLERK|AUTH|SESSION|NEXTAUTH)/.test(v)) return 'Authentication';
  if (/(LOG|LEVEL|SENTRY|OTEL|LOGGER)/.test(v)) return 'Observability';
  return 'Application';
}

/**
 * Build fix plans for a set of findings.
 *
 * Each rule contributes at most one fix per scan: a repo with fifty
 * unvalidated routes should get one shared schema, not fifty copies.
 */
export function planFixes(
  findings: readonly Finding[],
  ctx: Omit<FixContext, 'finding'>,
  limit = 10,
): FixPlanResult {
  const seen = new Set<string>();
  const fixes: FileFix[] = [];
  const unsupportedFixable: Finding[] = [];

  for (const f of findings) {
    if (!f.fixable) continue;
    const fixer = FIXABLE_RULES[f.ruleId];
    if (!fixer) {
      unsupportedFixable.push(f);
      continue;
    }
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    const built = fixer.build({ ...ctx, finding: f });
    if (!built || built.length === 0) continue;
    for (const entry of built) {
      fixes.push({
        ...entry,
        ruleId: f.ruleId,
        title: fixer.title,
        description: fixer.description,
        requiresReview: fixer.requiresReview || entry.requiresReview,
        category: f.category,
        severity: f.severity,
      });
    }
    if (seen.size >= limit) break;
  }

  return { fixes, unsupportedFixable };
}

/** Internal helper so each fixer stays readable. */
function fix(
  ctx: FixContext,
  entry: Omit<FileFix, 'ruleId' | 'title' | 'description' | 'category' | 'severity' | 'requiresReview'> &
    Partial<Pick<FileFix, 'requiresReview'>>,
): FileFix {
  void ctx;
  return {
    ...entry,
    requiresReview: entry.requiresReview ?? true,
    category: '',
    severity: 'medium',
  } as FileFix;
}

export type { ProductionImpact };
export { listTemplates, render, readTemplate, TEMPLATE_DIR } from './templates.js';
export type { EmitInput, RuleMeta };