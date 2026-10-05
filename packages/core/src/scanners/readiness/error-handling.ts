import { internals } from '../../context.js';
import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import {
  anchorPath,
  allFiles,
  ext,
  filesWithExts,
  findServerEntry,
  isBlankBlock,
  JS_EXTS,
  readBlock,
  stackLabel,
  SERVER_EXTS,
} from './helpers.js';
import type { SourceFile } from '../../source.js';
import type { Finding, ScanContext } from '../../types.js';

/**
 * Error handling.
 *
 * Ten checks. The theme: a failure that leaves no trace is worse than a
 * failure that is visible, because it is discovered by a customer instead of
 * by you. AI-generated code is over-represented here -- it reaches for
 * `try/catch` as a reflex and then returns a success shape from the catch.
 */
export const errorHandlingRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/error-handling/empty-catch',
      name: 'Silent catch block swallows the error',
      category: 'error-handling',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.97,
      effortMinutes: 10,
      fixable: true,
      description:
        'A catch block with an empty body discards the error. The failure becomes invisible: no log, no user-facing message, no metric. By the time a user reports "it did not work" there is nothing left to debug from.',
      remediation:
        'Log the error with its context, rethrow it, or return a typed failure. If the error really is expected, say so in a comment and increment a counter instead.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.gdprArticle33],
      cwe: 'CWE-390',
      tags: ['silent-failure', 'debuggability'],
      references: ['https://eslint.org/docs/latest/rules/no-empty'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py', '.rb', '.go', '.rs', '.java')) {
        for (let line = 1; line <= file.lineCount; line++) {
          const text = file.line(line);
          const kw = /\b(catch|except|rescue|recover)\b/.exec(text);
          if (!kw) continue;
          const block = readBlock(file, line);
          if (block === null || !isBlankBlock(block, text)) continue;
          if (file.hasExplanatoryCommentNear(line, ['ignore', 'expected', 'intentional', 'noop', 'nothing to do', 'optional', 'best effort'])) continue;
          yield emit({
            path: file.path,
            line,
            snippet: text,
            evidence: `Empty \`${kw[0]}\` block discards the error without logging or rethrowing`,
            tags: ['silent-failure'],
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/error-handling/unhandled-promise',
      name: 'Promise discarded with no handler',
      category: 'error-handling',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.8,
      effortMinutes: 20,
      fixable: false,
      description:
        'A promise is started and never awaited, returned, assigned or caught. Its rejection is unhandled: in Node this can terminate the process, and in every runtime it produces no log and no user feedback. This is how an AI-generated background job silently stops running after a deploy.',
      remediation:
        'Await it, return it, or attach a `.catch()` that logs the failure. If the work is genuinely fire-and-forget, say so with `void doWork().catch(logError)` so the rejection is handled rather than lost.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.euAiActArticle12],
      cwe: 'CWE-248',
      tags: ['reliability', 'silent-failure'],
      references: ['https://nodejs.org/api/process.html#processunhandledrejection'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS)) {
        if (/(^|\/)(test|tests|__tests__|fixtures)\//.test(file.path)) continue;
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line).replace(/\/\*.*?\*\//g, '');
          if (code === '') continue;

          // `.then()` with no `.catch()`: a rejection has nowhere to go, *unless*
          // the promise is returned (the caller handles it) or the chain is
          // continued on a later line.
          const thenHit = /\.then\s*\(/.exec(code);
          if (thenHit && !/\.catch\s*\(|,\s*(?:\(?\s*(?:err|error|e)\b|\w+\s*=>)/.test(code.slice(thenHit.index))) {
            // A returned promise is handled by whoever awaited the caller.
            const propagated = /\breturn\b/.test(code) || /\bawait\b/.test(code);
            // A chain split across lines has its handler somewhere below.
            const continuesBelow = chainHasHandlerBelow(file, line);
            if (!propagated && !continuesBelow) {
              yield emit({
                path: file.path,
                line,
                snippet: file.line(line),
                evidence: 'promise chain ends in .then() with no .catch() and no rejection handler',
                confidenceScale: 0.85,
                tags: ['reliability'],
              });
            }
          }

          // A call statement whose result is discarded entirely.
          const callHit = /^\s*([A-Za-z_$][\w$.]*)\s*\(\s*[^;]*\)\s*;?\s*$/.exec(code);
          if (!callHit) continue;
          const callee = callHit[1]!;
          // `process.on(...)`, `process.stdout.write(...)` and friends are
          // synchronous: they register a listener or return a boolean.
          // Instrumenting process output is exactly what an observed process
          // should be doing, and reporting it is the kind of finding that makes
          // a team disable the rule wholesale. `write` matching the async-name
          // test below is what pulls these in.
          if (/^(?:process|console|emitter|bus|events|router|app)(?:\.\w+)*\.(?:on|once|off|addListener|write|end|log|info|warn|error|debug)$/.test(callee)) {
            continue;
          }
          if (!/(?:^|\.)(?:then|next|setImmediate|setTimeout|emit|on|addEventListener|useEffect)$/.test(callee)) continue;
          if (!/^(?:async\s+)?[\w$.]*(?:Async|Fetch|Save|Update|Delete|Create|Send|Sync|Upload|Store|Write|Persist|Process|Emit|Dispatch|Enqueue|Queue|Notify|Index|Embed|Generate)/i.test(callee)) continue;
          if (file.hasExplanatoryCommentNear(line, ['fire and forget', 'fire-and-forget', 'best effort', 'ignore', 'non-blocking', 'shipready-ignore', 'intentional'])) continue;
          yield emit({
            path: file.path,
            line,
            snippet: file.line(line),
            evidence: `\`${callee}(...)\` is called as a statement: the promise is neither awaited, returned, nor caught`,
            confidenceScale: 0.75,
            tags: ['reliability'],
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/error-handling/no-global-handler',
      name: 'Server has no global error handler',
      category: 'error-handling',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 60,
      fixable: true,
      description:
        'A server framework is present but no error-handling middleware is registered. Unhandled errors produce an empty 500 with no stack trace in logs, no correlation id for support to search on, and frequently leak internals to the user.',
      remediation:
        'Register error middleware after all routes: Express `app.use((err, req, res, next) => ...)`, FastAPI `@app.exception_handler(Exception)`, Django custom 500 handler, Go a top-level `recover()` middleware. Log the error, return a generic message plus a correlation id.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.gdprArticle32, COMPLIANCE.euAiActArticle12],
      cwe: 'CWE-755',
      owasp: 'A05:2021',
      tags: ['middleware', 'launch-blocker'],
      references: ['https://expressjs.com/en/guide/error-handling.html'],
    },
    function* (ctx, emit) {
      if (!hasHttpServer(ctx)) return;
      // Next.js, Nuxt and SvelteKit handle unhandled route errors internally and
      // surface them through error.tsx / +error.ts -- but only for their own
      // routes. A repo that also runs a standalone Express or FastAPI server
      // still needs middleware for that server.
      if (hasFrameworkErrorBoundary(ctx) && !hasStandaloneServer(ctx)) return;
      const files = allFiles(ctx);
      const code = files.map((f) => f.noCommentsOrStrings).join('\n');
      if (hasErrorMiddleware(code, ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: `${stackLabel(ctx)} server detected with no error-handling middleware registered`,
        data: { framework: ctx.project.type },
      });
    },
    (ctx) => hasHttpServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/error-handling/no-error-boundary',
      name: 'React app has no error boundary',
      category: 'error-handling',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: true,
      description:
        'A React or Next.js app renders components with no error boundary. One throw during render unmounts the whole tree: the user sees a white screen and the error is visible only if someone happens to have devtools open.',
      remediation:
        'Add `app/error.tsx` for Next.js App Router segments, a page-level `error.tsx`, or an `ErrorBoundary` class around the app shell. Pair it with a `window.onerror` handler that reports to your error tracker.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['react', 'ux'],
      references: ['https://nextjs.org/docs/app/building-your-application/routing/error-handling'],
    },
    function* (ctx, emit) {
      if (!isReactFamily(ctx)) return;
      const files = ctx.files();
      const hasBoundary =
        files.some((f) => /(^|\/)(error|global-error|ErrorBoundary)\.(t|j)sx?$/.test(f)) ||
        files.some((f) => /componentDidCatch|getDerivedStateFromError|<ErrorBoundary/.test(f));
      if (hasBoundary) return;
      yield emit({
        path: anchorPath(ctx, ['app/error.tsx', 'src/app/error.tsx', 'pages/_error.tsx', 'src/App.tsx']),
        evidence: 'React-family app with no error boundary file or ErrorBoundary component',
        data: { components: ctx.project.components.length },
      });
    },
    (ctx) => isReactFamily(ctx),
  ),

  defineRule(
    {
      id: 'readiness/error-handling/no-retry-logic',
      name: 'Remote call has no timeout or retry',
      category: 'error-handling',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.65,
      effortMinutes: 40,
      fixable: false,
      description:
        'A call to a remote service has neither a timeout nor retry handling. One slow or blipped dependency becomes a user-visible failure, and there is no bound on how long the request can hang. This matters more than usual when the dependency is an LLM provider, where p99 latency is seconds.',
      remediation:
        'Wrap the call in a helper that enforces a timeout (`AbortSignal.timeout`) and retries idempotent operations with exponential backoff and jitter. Cap both attempt count and total elapsed time.',
      compliance: [COMPLIANCE.euAiActArticle15, COMPLIANCE.nis2Art21],
      tags: ['resilience', 'latency'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout'],
    },
    function* (ctx, emit) {
      if (ctx.project.totalLines === 0) return;
      const netCall =
        /\bfetch\s*\(|axios\.(get|post|put|patch|delete|request)|got\s*\(|requests\.(get|post|put|patch|delete)\s*\(|httpx\.(get|post|Client)|openai\.|anthropic\.|\.chat\.completions\.create|generateContent\(/;
      for (const file of filesWithExts(ctx, ...JS_EXTS, ...['.py', '.go', '.rb'])) {
        if (/(^|\/)(test|tests|__tests__|fixtures)\//.test(file.path)) continue;
        // A client configured with a timeout or retries, or an SDK that retries
        // by default (the OpenAI and Anthropic clients both do), already has
        // this protection. Matching on the bare words is intentional here: it
        // is what makes `new OpenAI({ timeout: 30_000, maxRetries: 2 })` count.
        if (/\btimeout\b|\bmaxRetries\b|\bmax_retries\b|\bretry\b|\bbackoff\b|tenacity|p-retry|make-retry|@retry|requests\.Session|httpx\.(?:Client|AsyncClient|Timeout)|retryablehttp|gax\.retry|AbortSignal\.timeout|AbortController/i.test(file.content)) continue;
        const hits = file.matchNoComments(netCall);
        if (hits.length === 0) continue;
        if (file.hasExplanatoryCommentNear(hits[0]!.line, ['timeout', 'retry', 'handled by', 'wrapped', 'sdk', 'helper'])) continue;
        yield emit({
          path: file.path,
          line: hits[0]!.line,
          snippet: hits[0]!.text,
          evidence: `${hits.length} remote call(s) with no timeout or retry in this file (first: \`${hits[0]!.match}\`)`,
          data: { calls: hits.length, client: hits[0]!.match },
        });
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/error-handling/no-process-guard',
      name: 'No unhandledRejection or uncaughtException handler',
      category: 'error-handling',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 20,
      fixable: true,
      description:
        'A long-running Node process registers no handler for `unhandledRejection` or `uncaughtException`. A single dropped promise can kill the worker with no log line, and there is no last-chance place to flush telemetry.',
      remediation:
        'In your entrypoint register `process.on("unhandledRejection")` and `process.on("uncaughtException")`, report both to your error tracker, and exit non-zero on `uncaughtException` so the orchestrator restarts you.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.euAiActArticle12],
      tags: ['reliability', 'nodejs'],
      references: ['https://nodejs.org/api/process.html#event-unhandledrejection'],
    },
    function* (ctx, emit) {
      // Serverless platforms own the process lifecycle: there is no long-lived
      // process to guard, and an unhandled rejection surfaces in their logs.
      if (isServerless(ctx)) return;
      if (!['node', 'nextjs', 'express', 'vite'].includes(ctx.project.type)) return;
      const files = filesWithExts(ctx, ...SERVER_EXTS);
      if (files.some((f) => /unhandledRejection|uncaughtException/.test(f.noComments))) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'Node process with no unhandledRejection / uncaughtException handler anywhere in the project',
      });
    },
    (ctx) => !isServerless(ctx) && ['node', 'nextjs', 'express', 'vite'].includes(ctx.project.type),
  ),

  defineRule(
    {
      id: 'readiness/error-handling/console-error-only',
      name: 'Errors only reach console, never an error tracker',
      category: 'error-handling',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 45,
      fixable: true,
      description:
        'Error handling is console-only. `console.error` output is invisible in production: it goes to a log aggregator nobody is watching, it is dropped on serverless, and it carries no user, request or release context. You find out about these errors from customers, if at all.',
      remediation:
        'Add `@sentry/node` (or equivalent), initialise it before your app code, and call `captureException` from your error middleware. Keep `console.error` for local development.',
      compliance: [COMPLIANCE.euAiActArticle12, COMPLIANCE.euAiActArticle72, COMPLIANCE.soc2CC7],
      tags: ['observability', 'sentry'],
      references: ['https://docs.sentry.io/platforms/javascript/guides/nextjs/'],
    },
    function* (ctx, emit) {
      if (hasErrorTracker(ctx)) return;
      const files = allFiles(ctx);
      const consoleErrors = files.reduce((n, f) => n + f.matchNoComments(/console\.(error|warn)\s*\(/).length, 0);
      if (consoleErrors < 2) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: `${consoleErrors} console.error/warn call(s) and no error-tracking SDK installed`,
        data: { consoleErrorCalls: consoleErrors },
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/error-handling/bare-except',
      name: 'Bare except swallows every exception type',
      category: 'error-handling',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.95,
      effortMinutes: 15,
      fixable: true,
      description:
        '`except:` with no exception type swallows programming errors, SystemExit and KeyboardInterrupt. Ctrl-C appears to do nothing, typos become mystery failures, and the stack trace you need is discarded.',
      remediation: 'Catch the specific exception types you expect. If you need a catch-all, use `except Exception:` and log it with `logger.exception(...)`.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['python', 'debuggability'],
      references: ['https://docs.python.org/3/library/exceptions.html'],
    },
    function* (ctx, emit) {
      if (!isPython(ctx)) return;
      for (const file of filesWithExts(ctx, '.py')) {
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          if (!/^\s*except\s*:\s*$/.test(code)) continue;
          yield emit({
            path: file.path,
            line,
            snippet: file.line(line),
            evidence: 'bare `except:` swallows all exceptions including SystemExit and KeyboardInterrupt',
          });
        }
      }
    },
    (ctx) => isPython(ctx),
  ),

  defineRule(
    {
      id: 'readiness/error-handling/no-request-timeout',
      name: 'API handler can hang indefinitely',
      category: 'error-handling',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 30,
      fixable: false,
      description:
        'An API route performs I/O with no timeout. Under a slow dependency, requests pile up, connection pools exhaust, and the whole service degrades instead of failing fast. This is the mechanism behind most cascading outages.',
      remediation:
        'Set an explicit timeout on every outbound call and a deadline on the handler. Return 504 on timeout so the client can retry rather than hang.',
      compliance: [COMPLIANCE.euAiActArticle15, COMPLIANCE.nis2Art21],
      tags: ['resilience', 'timeouts'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504'],
    },
    function* (ctx, emit) {
      if (!hasApiRoutes(ctx)) return;
      for (const path of ctx.project.apiRoutes) {
        const file = filesWithExts(ctx, ext(path)).find((f) => f.path === path);
        if (!file) continue;
        if (!isRouteHandler(file)) continue;
        if (/timeout|AbortSignal|signal\s*:|maxDuration|runtime\s*=/i.test(file.content)) continue;
        if (!/await\s+(fetch|axios|prisma|db|client|supabase|redis|openai|anthropic|getClient)/.test(file.noComments)) continue;
        yield emit({
          path: file.path,
          line: 1,
          snippet: file.line(1),
          evidence: 'route handler performs outbound I/O but configures no timeout',
          confidenceScale: 0.85,
        });
      }
    },
    (ctx) => hasApiRoutes(ctx),
  ),

  defineRule(
    {
      id: 'readiness/error-handling/success-after-error',
      name: 'Handler returns a success status after an internal error',
      category: 'error-handling',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.75,
      effortMinutes: 25,
      fixable: false,
      description:
        'A catch block returns a success status after an internal failure. The client treats the request as successful, data is silently lost, and the failure never reaches monitoring. This pattern shows up constantly in AI-generated payment and signup flows.',
      remediation:
        'Map internal errors to a 5xx status, include a correlation id in the body, and return a typed error result rather than a bare success shape.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.gdprArticle33],
      tags: ['api', 'data-integrity'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...SERVER_EXTS)) {
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          const isCatch = /\bcatch\s*(\(|\{)/.test(code);
          const isPromiseCatch = /\.catch\s*\(/.test(code);
          if (!isCatch && !isPromiseCatch) continue;

          // Read only the handler of this catch: the block that follows it.
          const body = catchBody(file, line);
          if (!body) continue;
          if (!/status\s*:\s*(200|201|204)\b|status\(200\)|NextResponse\.json\(/.test(body)) continue;
          // Only a *catch of a failure* counts. A success-shaped return that
          // merely mentions `error` as a field name is not this bug.
          if (!/catch\s*\(\s*(?:err|error|e\b|_?err)/.test(code) && !/catch\s*\{\s*\}/.test(code)) continue;
          yield emit({
            path: file.path,
            line,
            snippet: file.line(line),
            evidence: 'error caught, then a 2xx response returned to the client',
          });
        }
      }
    },
  ),
];

// ---------------------------------------------------------------------------

/**
 * The body of a catch block, as a string.
 *
 * For `catch (e) { ... }` this is the brace block. For
 * `promise.catch((e) => { ... })` it is the arrow body, stopping at the end of
 * the chain rather than running to the end of the file -- which is what made
 * the previous implementation report unrelated success responses further down.
 */
function catchBody(file: SourceFile, line: number, maxLines = 10): string | null {
  const text = file.line(line);
  const braceIndex = text.indexOf('{');
  const hasBraceBody = braceIndex >= 0;

  if (hasBraceBody) {
    let depth = 0;
    let acc = '';
    for (let l = line; l <= Math.min(file.lineCount, line + maxLines); l++) {
      const t = file.line(l);
      acc += ` ${t}`;
      for (const ch of t) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth <= 0) return acc;
    }
    return null;
  }

  // Arrow form: `x.catch((e) => expr)` or `x.catch(e => { ... })`.
  const arrow = text.indexOf('=>');
  if (arrow < 0) return null;
  const rest = text.slice(arrow + 2).trim();
  if (rest.startsWith('{')) {
    let depth = 0;
    let acc = '';
    for (let l = line; l <= Math.min(file.lineCount, line + maxLines); l++) {
      const t = file.line(l);
      acc += ` ${t}`;
      for (const ch of t) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth > 0) {
        // Reached the end of the block: stop, rather than reading further down
        // and picking up a success response from an unrelated code path.
        if (depth === 0) return acc;
      }
    }
    return null;
  }
  // Single-expression body ends at the closing paren of the .catch call.
  const end = text.indexOf(')', arrow);
  return end > 0 ? text.slice(arrow, end + 1) : rest || null;
}

/**
 * True when the project runs a server process of its own.
 *
 * Deliberately excludes Next.js, Vite and other build-tool-driven frameworks:
 * a deployed Next.js app *is* a server, but there is no `app.listen()` to guard,
 * and several rules below would produce advice that does not apply.
 */
/** True when a separate server process exists alongside a meta-framework. */
function hasStandaloneServer(ctx: ScanContext): boolean {
  const serverFiles = ctx.files().filter((f) => /(^|\/)(server|main|app)\.(ts|js|mjs|cjs|py|go|rs)$/.test(f));
  return serverFiles.some((f) => /\.(listen|app|application)\s*\(|uvicorn|serve\(|Flask\s*\(|FastAPI\s*\(|express\(\)/.test(
    internals.parse(ctx, f)?.content ?? '',
  ));
}

/** Deployed somewhere that owns the process lifecycle (Vercel, Lambda, Cloud Run). */
function isServerless(ctx: ScanContext): boolean {
  if (ctx.project.frameworks.includes('vercel') || ctx.project.frameworks.includes('cloudflare')) return true;
  if (['@vercel/node', '@netlify/functions', 'serverless-http', '@aws-lambda'].some((d) => ctx.project.dependencyNames.has(d))) return true;
  return ctx.files().some((f) => /^(vercel\.json|netlify\.toml|serverless\.ya?ml|template\.ya?ml|app\.yaml)$/.test(f));
}

/**
 * True when a `.then(` on `line` has its `.catch(` or second argument a few
 * lines below, at the same indentation.
 *
 * Chained promises are conventionally written across lines:
 *   result
 *     .then(a)
 *     .catch(b)
 * A line-only check reports every one of them as unhandled, which is the
 * difference between a useful rule and one people disable.
 */
function chainHasHandlerBelow(file: SourceFile, line: number): boolean {
  const indent = (file.line(line).match(/^\s*/)?.[0].length ?? 0);
  for (let l = line + 1; l <= Math.min(file.lineCount, line + 6); l++) {
    const text = file.line(l);
    if (text === '') continue;
    const nextIndent = text.match(/^\s*/)?.[0].length ?? 0;
    if (nextIndent < indent) break;
    if (/\.(catch|finally)\s*\(/.test(text)) return true;
    // A new statement at this indentation ends the chain.
    if (nextIndent === indent && !/^\s*\./.test(text) && !/^\s*\)/.test(text)) break;
  }
  return false;
}

function hasHttpServer(ctx: ScanContext): boolean {
  const p = ctx.project;
  if (['vite'].includes(p.type)) return false;
  return (
    p.type === 'express' ||
    p.type === 'fastapi' ||
    p.type === 'django' ||
    p.type === 'go' ||
    p.type === 'rust' ||
    p.frameworks.includes('express') ||
    p.frameworks.includes('node-server') ||
    p.frameworks.includes('fastapi') ||
    p.frameworks.includes('django') ||
    p.frameworks.includes('go') ||
    p.dependencyNames.has('express') ||
    p.dependencyNames.has('fastify') ||
    p.dependencyNames.has('koa') ||
    p.dependencyNames.has('hono') ||
    p.dependencyNames.has('fastapi') ||
    p.dependencyNames.has('django') ||
    p.dependencyNames.has('flask') ||
    p.dependencyNames.has('gunicorn')
  );
}

function hasErrorMiddleware(code: string, ctx: ScanContext): boolean {
  if (
    /app\.use\s*\(\s*\(?\s*(err|error)\s*,/.test(code) ||
    /\berr\s*,\s*req(uest)?\s*,\s*res(ponse)?\s*,/.test(code) ||
    /fastify\.setErrorHandler/.test(code) ||
    /app\.exception_handler/.test(code) ||
    /@app\.exception_handler/.test(code) ||
    /errorhandler|error_handler|ErrorMiddleware|errorHandler\(/.test(code) ||
    /panic::catch_unwind|panic::AssertUnwindSafe/.test(code) ||
    /recover\(\)/.test(code) ||
    /middleware\.(Recover|ErrorHandler)/.test(code) ||
    /Rack::Handler|rescue_from|rescue_from_exception/.test(code)
  ) {
    return true;
  }
  // Django: a custom 500 template or handler string in settings.
  if (ctx.project.frameworks.includes('django')) {
    const settings = code;
    if (/handler500|500\.html|error_500/.test(settings)) return true;
  }
  return false;
}

function isReactFamily(ctx: ScanContext): boolean {
  const p = ctx.project;
  return (
    p.type === 'nextjs' ||
    p.frameworks.includes('react') ||
    p.frameworks.includes('svelte') ||
    p.frameworks.includes('vue') ||
    p.frameworks.includes('angular') ||
    p.dependencyNames.has('react')
  );
}

/**
 * Frameworks with built-in error boundaries for server routes.
 *
 * Next.js, Nuxt and SvelteKit catch a throw inside a route handler and render
 * the nearest error.tsx / +error.ts. There is no middleware to register, so
 * flagging one is a false positive: the correct advice for those frameworks is
 * the separate `no-error-boundary` check.
 */
function hasFrameworkErrorBoundary(ctx: ScanContext): boolean {
  return ctx.project.type === 'nextjs' || ctx.project.frameworks.includes('nuxt') || ctx.project.frameworks.includes('svelte');
}

function hasErrorTracker(ctx: ScanContext): boolean {
  return [
    '@sentry/node',
    '@sentry/nextjs',
    '@sentry/react',
    '@sentry/python',
    '@sentry/browser',
    'rollbar',
    '@rollbar/rollbar-node',
    'bugsnag',
    'datadog',
    'newrelic',
    'elastic-apm-node',
    'logRocket',
  ].some((d) => ctx.project.dependencyNames.has(d));
}

function isPython(ctx: ScanContext): boolean {
  return ['python', 'fastapi', 'django'].includes(ctx.project.type);
}

function hasApiRoutes(ctx: ScanContext): boolean {
  return ctx.project.apiRoutes.some((f) => JS_EXTS.includes(ext(f)));
}

function isRouteHandler(file: { content: string }): boolean {
  return /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b|\.(get|post|put|patch|delete)\s*\(\s*['"`]/.test(
    file.content,
  );
}

export type { Finding };
