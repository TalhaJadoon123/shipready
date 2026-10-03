import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import {
  allFiles,
  ext,
  filesWithExts,
  findServerEntry,
  JS_EXTS,
  SERVER_EXTS,
  stackLabel,
} from './helpers.js';
import type { SourceFile } from '../../source.js';
import type { ScanContext } from '../../types.js';

const STATE_CHANGING = /\b(POST|PUT|PATCH|DELETE)\b|\.(post|put|patch|delete)\s*\(/;

export const securityRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/security/no-rate-limiting',
      name: 'No rate limiting on API endpoints',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      // Rate limiting is often present somewhere the code cannot show: a WAF, a
      // gateway, the hosting platform. Confidence is reduced accordingly rather
      // than asserting the absence as fact.
      confidence: 0.8,
      effortMinutes: 60,
      fixable: true,
      description:
        'API routes are reachable with no rate limit. Anyone can script requests against them: this exhausts your database, burns your LLM token budget, or gets your app used to send spam from your own infrastructure. For AI endpoints it is the single most reliable way to run up a five-figure bill overnight.',
      remediation:
        'Add a rate limiter at the app level: `express-rate-limit` or `@upstash/ratelimit` for Node, `slowapi` for FastAPI. Set a per-IP and per-user limit, a tighter limit on expensive endpoints (LLM calls, signup, password reset), and return 429 with `Retry-After`.',
      compliance: [COMPLIANCE.owaspA07, COMPLIANCE.gdprArticle32, COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A5],
      cwe: 'CWE-770',
      owasp: 'A07:2021',
      tags: ['abuse', 'cost', 'launch-blocker', 'ai-cost'],
      references: [
        'https://expressjs.com/en/resources/middleware/rate-limit-middleware.html',
        'https://owasp.org/www-community/attacks/DoS',
      ],
    },
    function* (ctx, emit) {
      if (!hasPublicApi(ctx)) return;
      if (hasRateLimiting(ctx)) return;
      const isAi = hasAiEndpoint(ctx);
      yield emit({
        path: findServerEntry(ctx),
        evidence: `${stackLabel(ctx)} with ${ctx.project.apiRoutes.length} API route(s) and no rate-limiting middleware`,
        data: { routes: ctx.project.apiRoutes.length, aiEndpoint: isAi },
        severity: isAi ? 'critical' : 'high',
        impact: 'blocker',
        effortMinutes: isAi ? 45 : 60,
        tags: isAi ? ['abuse', 'cost', 'launch-blocker', 'ai-cost'] : ['abuse', 'launch-blocker'],
      });
    },
    (ctx) => hasPublicApi(ctx),
  ),

  defineRule(
    {
      id: 'readiness/security/no-input-validation',
      name: 'API route accepts input without validation',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.78,
      effortMinutes: 40,
      fixable: false,
      description:
        'A route handler reads parameters from the request and uses them without validating shape or type. Unvalidated input reaches a database query, a filesystem path, a shell command, or an LLM prompt. This is the most common real vulnerability in AI-generated code, because the generated handler destructures `req.body` and moves on.',
      remediation:
        'Validate at the boundary with a schema: Zod, Valibot, Pydantic or equivalent. Parse before any use, reject unknown keys, and enforce length and format limits. Never interpolate unvalidated input into SQL, shell commands or file paths.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.gdprArticle25, COMPLIANCE.iso27001A8],
      cwe: 'CWE-20',
      owasp: 'A05:2021',
      tags: ['input-validation', 'launch-blocker', 'injection'],
      references: [
        'https://zod.dev/',
        'https://owasp.org/www-project-top-ten/2021/A03_2021-Injection',
      ],
    },
    function* (ctx, emit) {
      for (const path of ctx.project.apiRoutes) {
        const file = filesWithExts(ctx, ext(path)).find((f) => f.path === path);
        if (!file) continue;
        if (!isRouteHandler(file)) continue;
        if (hasValidation(ctx, file)) continue;
        const inputUsed = unvalidatedInput(file);
        if (!inputUsed) continue;
        yield emit({
          path: file.path,
          line: inputUsed.line,
          snippet: inputUsed.text,
          evidence: `reads \`${inputUsed.source}\` from the request and uses it with no schema validation`,
          data: { inputSource: inputUsed.source },
        });
      }
    },
    (ctx) => ctx.project.apiRoutes.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/security/no-cors-config',
      name: 'No explicit CORS configuration',
      category: 'security',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 25,
      fixable: true,
      description:
        'The server has browser-facing routes and never calls a CORS middleware or sets CORS headers. The default browser behaviour is to block the frontend, which usually gets "fixed" by switching on `Access-Control-Allow-Origin: *` in production -- which then makes the API callable by any site a user visits.',
      remediation:
        'Configure CORS explicitly with an allowlist of origins. Use the `cors` package in Node, `CORSMiddleware` with `allow_origins` in FastAPI, and never combine `origin: true` or a wildcard with `credentials: true`.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-942',
      owasp: 'A05:2021',
      tags: ['cors', 'api'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS'],
    },
    function* (ctx, emit) {
      if (!hasBrowserClient(ctx)) return;
      if (hasCorsConfig(ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'browser client present but no CORS middleware or Access-Control-Allow-Origin in any server file',
      });
    },
    (ctx) => hasBrowserClient(ctx) && hasHttpServerLike(ctx),
  ),

  defineRule(
    {
      id: 'readiness/security/wildcard-cors',
      name: 'CORS allows any origin',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 20,
      fixable: false,
      description:
        'CORS is configured with a wildcard origin. Any website a logged-in user visits can make authenticated requests to your API and read the responses. Combined with cookie auth this is a full account takeover primitive.',
      remediation:
        'Replace the wildcard with an explicit allowlist of your own origins. If you need dynamic origins, look them up in a table and only echo a match. Remember `Allow-Origin: *` is incompatible with credentials anyway.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-942',
      owasp: 'A05:2021',
      tags: ['cors', 'launch-blocker'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...SERVER_EXTS, '.py', '.go', '.rb', '.php')) {
        // String-masked, so a wildcard quoted inside prose is not a
        // misconfiguration. Matching raw text made this rule report its own
        // remediation string.
        for (const hit of file.matchCode(
          /(?:Access-Control-Allow-Origin["'\s]*[:,]\s*|origin\s*:\s*|allow_origins\s*=\s*)["']?\*|origin\s*:\s*true|allow_origins\s*=\s*\[\s*["']\*["']\s*\]/g,
        )) {
          // A wildcard mentioned in prose -- a remediation string, a doc comment -- is
          // not a misconfiguration. Require it to be an actual value.
          const line = file.lineNoComments(hit.line);
          if (!/(?:=|:|\(|,\s*)["']?\*["']?\s*[,;)\]}]/.test(line) && !/:\s*true\b/.test(line)) continue;
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;

          const permissiveCredentials =
            /credentials\s*:\s*true|allow_credentials\s*=\s*True/.test(file.content);
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: permissiveCredentials
              ? 'CORS allows any origin AND credentials are enabled -- any site can make authenticated requests'
              : 'CORS origin set to wildcard `*`',
            data: { withCredentials: permissiveCredentials },
            severity: 'critical',
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/missing-security-headers',
      name: 'No security response headers',
      category: 'security',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 30,
      fixable: true,
      description:
        'Responses go out without a Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, X-Frame-Options or Strict-Transport-Security. That removes the browser-side defences that would otherwise contain an XSS or clickjacking bug you have not found yet.',
      remediation:
        'Set the headers in one place: `helmet` for Express, `CORSMiddleware` plus a middleware for FastAPI, `headers()` in `next.config.js` for Next.js. Start with a CSP in report-only mode, then enforce.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.owaspA02, COMPLIANCE.iso27001A8, COMPLIANCE.nis2Art21],
      cwe: 'CWE-693',
      owasp: 'A05:2021',
      tags: ['headers', 'xss', 'defence-in-depth'],
      references: ['https://helmetjs.github.io/'],
    },
    function* (ctx, emit) {
      if (ctx.project.type === 'unknown') return;
      if (!hasBrowserClient(ctx) && !hasHttpServerLike(ctx)) return;
      if (hasSecurityHeaders(ctx)) return;
      const missing = missingHeaders(ctx);
      yield emit({
        path: findServerEntry(ctx),
        evidence: `no security headers configured. Missing: ${missing.join(', ')}`,
        data: { missing },
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/security/no-csrf',
      name: 'Cookie-authenticated state change with no CSRF defence',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.65,
      effortMinutes: 45,
      fixable: true,
      description:
        'The app authenticates with cookies and accepts state-changing requests with no CSRF token, no SameSite protection, and no origin check. A malicious page can make any logged-in user perform actions in your app: change an email, delete an account, trigger a purchase.',
      remediation:
        'Set `SameSite=Lax` or `Strict` on session cookies, require a CSRF token on non-idempotent requests (or a custom header check), and verify the `Origin` header on state-changing routes. Bearer-token clients are not affected, so confirm you actually use cookies.',
      compliance: [COMPLIANCE.owaspA01, COMPLIANCE.owaspA07],
      cwe: 'CWE-352',
      owasp: 'A01:2021',
      tags: ['csrf', 'auth', 'launch-blocker'],
      references: ['https://owasp.org/www-community/attacks/csrf'],
    },
    function* (ctx, emit) {
      if (!usesCookieAuth(ctx)) return;
      // A CSRF token or SameSite policy set by the framework counts: NextAuth,
      // Lucia and Clerk all set SameSite=Lax on their session cookies.
      if (hasCsrfDefence(ctx)) return;
      const mutating = countMutatingRoutes(ctx);
      if (mutating === 0) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: `${mutating} state-changing route(s) authenticated by cookies with no CSRF token, SameSite policy or origin check`,
        data: { mutatingRoutes: mutating },
        // Cookie auth is often present without browser-reachable mutating
        // routes (a webhook, a mobile client). Require real confidence before
        // calling this a launch blocker.
        confidenceScale: 0.8,
      });
    },
    (ctx) => usesCookieAuth(ctx),
  ),

  defineRule(
    {
      id: 'readiness/security/insecure-cookie',
      name: 'Auth cookie missing httpOnly / secure / sameSite',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.8,
      effortMinutes: 15,
      fixable: false,
      description:
        'A session or auth cookie is set without `httpOnly`, `secure`, or `sameSite`. Without `httpAny` an XSS bug becomes session theft; without `secure` the cookie travels in plaintext; without `sameSite` it is sent on cross-site requests.',
      remediation:
        'Set `httpOnly: true`, `secure: true`, `sameSite: "lax"` (or `strict` for admin) on every session cookie. Centralise cookie creation in one helper so the flags cannot drift.',
      compliance: [COMPLIANCE.owaspA07, COMPLIANCE.owaspA02, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-614',
      owasp: 'A07:2021',
      tags: ['auth', 'cookies', 'session'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py', '.go', '.rb', '.php', '.java')) {
        for (const hit of file.matchNoComments(
          /(?:cookies?\(\)|setCookie|set_cookie|Set-Cookie|cookieOptions)\s*[.({]/g,
        )) {
          const block = file.content.slice(hit.index, hit.index + 700);
          if (!/(session|auth|token|jwt|sid|refresh)/i.test(block)) continue;
          if (file.hasExplanatoryCommentNear(hit.line, ['secure', 'httpOnly', 'samesite', 'managed by', 'auth library', 'clerk', 'next-auth', 'lucia', 'better-auth'])) continue;
          const missing: string[] = [];
          if (!/httpOnly\s*:\s*true|http_only\s*=\s*True|httpOnly\s*=\s*True/i.test(block)) missing.push('httpOnly');
          if (!/secure\s*:\s*true|secure\s*=\s*True/i.test(block)) missing.push('secure');
          if (!/sameSite\s*:\s*['"](?:lax|strict|none)|samesite\s*=\s*['"](?:lax|strict|none)/i.test(block)) missing.push('sameSite');
          if (missing.length === 0) continue;
          if (missing.length < 3) continue; // all three absent is the real signal
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `session cookie created without ${missing.join(', ')}`,
            data: { missing },
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/weak-hash',
      name: 'Weak hash or cipher used for auth or secrets',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: false,
      description:
        'MD5 or SHA-1 is used for passwords, tokens, or integrity checks. MD5 collisions take seconds on a laptop. Even SHA-256 unsalted is wrong for passwords, which need a slow, salted KDF.',
      remediation:
        'Passwords: bcrypt, scrypt, Argon2id. Tokens and API keys: HMAC-SHA256 or a JWT library. Integrity: SHA-256 or better. Never roll your own.',
      compliance: [COMPLIANCE.owaspA02, COMPLIANCE.iso27001A8, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-327',
      owasp: 'A02:2021',
      tags: ['crypto', 'auth', 'launch-blocker'],
      references: ['https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py', '.go', '.rb', '.php', '.java', '.cs')) {
        for (const hit of file.matchNoComments(/\b(md5|sha1|MD5|SHA1)\s*\(/g)) {
          const block = file.content.slice(hit.index, hit.index + 300);
          if (!/(password|passwd|pwd|token|secret|apikey|api_key|sign|signature|hmac)/i.test(block)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `\`${hit.match}\` used near password/token/secret handling`,
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/dangerously-set-inner-html',
      name: 'Unescaped HTML rendering',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.8,
      effortMinutes: 30,
      fixable: false,
      description:
        'Dynamic content is injected as raw HTML. If any part of that content is user-controlled or model-generated, this is stored or reflected XSS. Model output is user-controlled for this purpose: an LLM will happily emit `<script>` if asked politely.',
      remediation:
        'Prefer React escaping. When you genuinely need HTML (a rich-text editor, a rendered markdown answer), sanitise with DOMPurify on the client and a server-side sanitiser, and never pass raw model output to `dangerouslySetInnerHTML`.',
      compliance: [COMPLIANCE.owaspA05, COMPLIANCE.llmTop10SensitiveInfo],
      cwe: 'CWE-79',
      owasp: 'A05:2021',
      tags: ['xss', 'llm-output', 'launch-blocker'],
      references: ['https://owasp.org/www-community/attacks/xss/'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte')) {
        // Match against the string-masked text: an HTML sink named inside a
        // remediation string is prose, not a vulnerability. Matching the raw text
        // made this rule report its own rule description.
        for (const hit of file.matchCode(/dangerouslySetInnerHTML|v-html|innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/g)) {
          const line = file.lineNoComments(hit.line);
          // Require an actual sink: an assignment or a call argument.
          if (!/=\s*[{"'`A-Za-z_$]|\(\s*[A-Za-z_$]/.test(line)) continue;
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
          // Look for a model *call* in the surrounding code, not the bare word
          // "output": a remediation string mentioning model output must not be
          // reported as a vulnerability in itself.
          const window = file.content.slice(Math.max(0, hit.index - 800), hit.index + 800);
          const reallyFromModel =
            /(?:choices\s*\[|message\.content|completion\s*\(|completions\.create|messages\.create|generateContent|\.completion\b|\bllm\b|\bopenai\b|\banthropic\b|\bgemini\b)/i.test(
              window,
            );
          if (file.hasExplanatoryCommentNear(hit.line, ['sanitiz', 'dompurify', 'trusted', 'already escaped', 'safe'])) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: reallyFromModel
              ? 'raw HTML injection fed by model output -- LLM output counts as untrusted input'
              : 'raw HTML injection with dynamic content',
            data: { fromModelOutput: reallyFromModel },
            severity: reallyFromModel ? 'critical' : 'high',
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/eval-usage',
      name: 'eval or dynamic code execution',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 45,
      fixable: false,
      description:
        'Dynamic code evaluation on runtime input. If any part of the evaluated string is user-controlled or model-generated, this is remote code execution with no further work required by an attacker.',
      remediation:
        'Replace `eval`, `new Function`, `vm.runInNewContext` and `child_process.exec` with a structured parser: `JSON.parse` for data, an allowlist dispatch table for commands, and `execFile` with an argument array for processes.',
      compliance: [COMPLIANCE.owaspA03, COMPLIANCE.iso27001A8],
      cwe: 'CWE-95',
      owasp: 'A03:2021',
      tags: ['rce', 'injection', 'launch-blocker'],
      references: ['https://owasp.org/www-community/attacks/Code_Injection'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py')) {
        for (const hit of file.matchNoComments(/\beval\s*\(|new\s+Function\s*\(|vm\.runIn(New|Context)Code|execSync\s*\(|child_process\.exec\s*\(|os\.system\s*\(|subprocess\.(call|run|Popen)\s*\(\s*[^,]*shell\s*=\s*True/g)) {
          if (file.hasExplanatoryCommentNear(hit.line, ['test', 'fixture', 'example', 'sandbox', 'trusted'])) continue;
          const snippet = file.content.slice(hit.index, hit.index + 200);
          if (/(test|spec|fixture)/i.test(file.path)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `dynamic code execution: \`${hit.match}\``,
            data: { construct: hit.match, context: snippet.slice(0, 80) },
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/sql-interpolation',
      name: 'SQL built by string interpolation',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: false,
      description:
        'A SQL query is assembled with a template literal or concatenation. If any interpolated value is user-controlled this is SQL injection: full read and write access to your database from an HTTP request.',
      remediation:
        'Use parameterised queries or a query builder that parameterises by default. Prisma `$queryRaw` tagged templates, Knex `.where(k, v)`, and Python `cursor.execute(sql, params)` all parameterise. Identifiers (table and column names) must come from a static allowlist, never from input.',
      compliance: [COMPLIANCE.owaspA03, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-89',
      owasp: 'A03:2021',
      tags: ['sql-injection', 'launch-blocker'],
      references: ['https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py', '.rb', '.php')) {
        for (const hit of file.matchNoComments(
          /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^\n]*?(?:\$\{|%\s*\(|["']\s*\+\s*\w|\.format\()/gi,
        )) {
          if (/(test|spec|fixture|migration|seed)/i.test(file.path)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text.slice(0, 200),
            evidence: 'SQL statement contains an interpolated value',
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/no-auth-on-api-route',
      name: 'API route has no authentication check',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.7,
      effortMinutes: 25,
      fixable: false,
      description:
        'A route handler that reads or writes data performs no authentication check. Any visitor can call it. This is extremely common in AI-generated Next.js apps: the route is written, the UI is wired up, and the auth check is never added because nothing in the happy path needs it.',
      remediation:
        'Authenticate at the top of every handler. Next.js: `auth()` from your auth library, or check the session in middleware for `/api/*`. Express: `requireAuth` middleware on the router. Fail closed: if the check throws, return 401, not 500.',
      compliance: [COMPLIANCE.owaspA01, COMPLIANCE.owaspA07, COMPLIANCE.iso27001A5, COMPLIANCE.soc2CC6],
      cwe: 'CWE-306',
      owasp: 'A01:2021',
      tags: ['auth', 'broken-access-control', 'launch-blocker', 'ai-specific'],
      references: ['https://owasp.org/Top10/A01_2021-Broken_Access_Control/'],
    },
    function* (ctx, emit) {
      if (!usesCookieAuth(ctx) && !hasAuthLibrary(ctx)) return;
      for (const path of ctx.project.apiRoutes) {
        const file = filesWithExts(ctx, ext(path)).find((f) => f.path === path);
        if (!file) continue;
        if (!isRouteHandler(file)) continue;
        if (hasAuthCheck(ctx, file)) continue;
        const readsData = /\b(await\s+)?(prisma|db|supabase|client)\b.*\.(find|select|create|update|delete|upsert|query)|SELECT\s|INSERT\s|UPDATE\s|\.get\('/i.test(
          file.noComments,
        );
        if (!readsData) continue;
        yield emit({
          path: file.path,
          line: 1,
          snippet: file.line(1),
          evidence: 'route handler reads or writes data with no auth/authz call in the handler or middleware',
          data: { route: path },
        });
      }
    },
    (ctx) => usesCookieAuth(ctx) || hasAuthLibrary(ctx),
  ),

  defineRule(
    {
      id: 'readiness/security/exposed-secret-env',
      name: 'Secret exposed through a public environment variable',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 20,
      fixable: true,
      description:
        'A variable whose name marks it as a secret (API key, service role, database URL, signing secret) is read through a public prefix, so it is compiled into the client bundle and visible to every user in devtools. `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, `PUBLIC_*` and `EXPO_PUBLIC_*` all do this.',
      remediation:
        'Remove the public prefix. Anything with a secret in the name must only be read on the server. If the client genuinely needs it, mint a scoped short-lived token from an API route instead of shipping the provider key.',
      compliance: [COMPLIANCE.owaspA02, COMPLIANCE.owaspA07, COMPLIANCE.gdprArticle32],
      cwe: 'CWE-200',
      owasp: 'A02:2021',
      tags: ['secrets', 'launch-blocker', 'ai-specific'],
      references: ['https://owasp.org/www-project-top-ten/2021/A02_2021-Cryptographic_Failures/'],
    },
    function* (ctx, emit) {
      const publicPrefixes = /(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC|EXPO_PUBLIC|GATSBY)_/;
      const secretName = /(SECRET|KEY|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|_DSN|DATABASE_URL|STRIPE_SECRET|ADMIN)/;
      for (const file of filesWithExts(ctx, '.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro')) {
        if (/(^|\/)(server|api|route|routes|lib\/server|trpc)\//.test(file.path) && !/client|component|\.tsx$/.test(file.path)) continue;
        for (const hit of file.matchNoComments(/process\.env\.[A-Z0-9_]+|import\.meta\.env\.[A-Z0-9_]+/g)) {
          const name = hit.match.split(/[.[]/)[2] ?? hit.match;
          if (!publicPrefixes.test(name)) continue;
          if (!secretName.test(name.replace(publicPrefixes, ''))) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `\`${name}\` is bundled into client JavaScript and readable by every user`,
            data: { variable: name },
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/security/no-helmet-or-headers',
      name: 'Production server has no security middleware',
      category: 'security',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 20,
      fixable: true,
      description:
        'The Express app never registers `helmet`. The default Node HTTP server sets no security headers at all: no CSP, no HSTS, no `X-Content-Type-Options`.',
      remediation: '`app.use(helmet())` as the first middleware, with a CSP you have actually tested rather than the library default.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-693',
      tags: ['headers', 'defence-in-depth'],
      references: ['https://helmetjs.github.io/'],
    },
    function* (ctx, emit) {
      if (!ctx.project.dependencyNames.has('express')) return;
      const files = filesWithExts(ctx, ...SERVER_EXTS);
      if (files.some((f) => /require\(["']helmet|from\s+["']helmet|app\.use\(\s*helmet/.test(f.content))) return;
      if (hasSecurityHeaders(ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'Express app with neither `helmet` nor manual security headers',
      });
    },
    (ctx) => ctx.project.dependencyNames.has('express'),
  ),
];

// ---------------------------------------------------------------------------

const SECURITY_HEADER_NAMES = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'X-Frame-Options',
  'Strict-Transport-Security',
];

function missingHeaders(ctx: ScanContext): string[] {
  const files = allFiles(ctx);
  const present = new Set<string>();
  for (const f of files) {
    for (const h of SECURITY_HEADER_NAMES) if (f.content.includes(h)) present.add(h);
  }
  if (/helmet\s*\(/.test(files.map((f) => f.content).join('\n'))) return [];
  return SECURITY_HEADER_NAMES.filter((h) => !present.has(h));
}

function hasSecurityHeaders(ctx: ScanContext): boolean {
  const missing = missingHeaders(ctx);
  // Two of the five is enough to count as an intentional configuration.
  return missing.length <= 3;
}

function hasBrowserClient(ctx: ScanContext): boolean {
  return (
    ctx.project.frameworks.includes('react') ||
    ctx.project.frameworks.includes('vue') ||
    ctx.project.frameworks.includes('svelte') ||
    ctx.project.type === 'nextjs' ||
    ctx.project.type === 'vite' ||
    ctx.project.dependencyNames.has('react') ||
    ctx.project.dependencyNames.has('vue')
  );
}

function hasHttpServerLike(ctx: ScanContext): boolean {
  return (
    ctx.project.type === 'express' ||
    ctx.project.frameworks.includes('node-server') ||
    ctx.project.frameworks.includes('fastapi') ||
    ctx.project.frameworks.includes('django') ||
    ctx.project.frameworks.includes('go') ||
    ctx.project.apiRoutes.length > 0
  );
}

function hasPublicApi(ctx: ScanContext): boolean {
  return ctx.project.apiRoutes.length > 0 || hasHttpServerLike(ctx);
}

function hasRateLimiting(ctx: ScanContext): boolean {
  const patterns =
    /express-rate-limit|rate-limiter-flexible|rateLimit\s*\(|slowapi|Limiter\(|@upstash\/ratelimit|@ratelimit\/|nestjs-throttler|fastapi-limiter|envoy|nginx.*limit_req|cloudflare.*rate|Upstash|apiRateLimit|bottleneck|Bottleneck|throttle|Throttle|RateLimiter/i;
  for (const f of allFiles(ctx)) if (patterns.test(f.content)) return true;
  if (['@upstash/ratelimit', '@upstash/redis', 'express-rate-limit', 'rate-limiter-flexible', 'slowapi', 'bottleneck', 'nestjs-throttler', 'fastapi-limiter'].some((d) => ctx.project.dependencyNames.has(d))) return true;
  if (ctx.project.frameworks.includes('vercel')) return true;
  return false;
}

function hasAiEndpoint(ctx: ScanContext): boolean {
  return filesWithExts(ctx, ...SERVER_EXTS, '.py').some((file) =>
    /\b(openai|anthropic|generateContent|chat\.completions\.create|messages\.create|invoke|generateText|ollama)\b/.test(
      file.noComments,
    ),
  );
}

/**
 * Explicit CORS configuration.
 *
 * A serverless API on Vercel, Netlify or Cloudflare gets platform-level CORS
 * (and OPTIONS preflight handling) with no code at all, so flagging those is a
 * false positive. Check the platform before reporting.
 */
function hasCorsConfig(ctx: ScanContext): boolean {
  const platformManaged = ['@vercel/node', '@netlify/functions', 'serverless-http', '@cloudflare/workers-types', 'hono'];
  if (platformManaged.some((d) => ctx.project.dependencyNames.has(d))) return true;
  if (ctx.project.frameworks.includes('vercel') || ctx.project.frameworks.includes('cloudflare')) return true;
  const patterns =
    /require\(["']cors|from\s+["']cors|app\.use\(\s*cors|cors\(\{|Access-Control-Allow-Origin|CORSMiddleware|allow_origins|AccessControl|corsMiddleware|@cross_origin/i;
  return allFiles(ctx).some((f) => patterns.test(f.content));
}

function hasValidation(ctx: ScanContext, file: SourceFile): boolean {
  const inFile =
    /\b(z\.object|zod|valibot|ajv|joi|yup|typebox|valibot|superstruct|pydantic|BaseModel|Field\(|marshmallow|cerberus|voluptuous|typeio|parse\(|safeParse\(|zodToJsonSchema|schema\.safeParse)\b/.test(
      file.content,
    );
  if (inFile) return true;
  if (!ctx.project.dependencyNames.has('zod') && !ctx.project.dependencyNames.has('yup') && !ctx.project.dependencyNames.has('joi') && !ctx.project.dependencyNames.has('valibot') && !ctx.project.dependencyNames.has('ajv')) return false;
  // Library is installed; check it is imported into this handler.
  return /from\s+["'](zod|yup|joi|valibot|ajv|superstruct)["']|require\(["'](zod|yup|joi|valibot|ajv)/.test(file.content);
}

function unvalidatedInput(file: SourceFile): { line: number; text: string; source: string } | null {
  const patterns: { re: RegExp; source: string }[] = [
    { re: /\b(?:req|request)\.(?:body|query|params)\b/, source: 'req.body / req.query / req.params' },
    { re: /\b(?:req|request)\.json\s*\(\s*\)/, source: 'await req.json()' },
    { re: /\b(?:req|request)\.formData\s*\(\s*\)/, source: 'await req.formData()' },
    { re: /\bnew\s+URL\s*\(\s*(?:req|request)\.\w*\s*\)/, source: 'URL query string' },
    { re: /\bsearchParams\.get\s*\(/, source: 'searchParams.get()' },
    { re: /\bctx\.(?:request|query|params)\b/, source: 'ctx.request / ctx.query' },
    { re: /\breq\.get\s*\(\s*['"]/i, source: 'request header' },
  ];
  for (const { re, source } of patterns) {
    const hit = file.matchNoComments(re)[0];
    if (!hit) continue;
    return { line: hit.line, text: hit.text, source };
  }
  return null;
}

/**
 * True when the app authenticates with an HTTP cookie.
 *
 * Requires either a session-cookie library or an explicit cookie *write*.
 * Merely reading `cookies()` (as a Next.js middleware does on every request)
 * is not proof of cookie authentication.
 */
function usesCookieAuth(ctx: ScanContext): boolean {
  const libs = [
    'next-auth',
    '@auth/core',
    'lucia',
    'better-auth',
    '@clerk/nextjs',
    '@clerk/clerk-sdk-node',
    'passport',
    'express-session',
    'iron-session',
    '@fastify/secure-session',
    'remix-auth',
    'iron-session',
  ];
  if (libs.some((l) => ctx.project.dependencyNames.has(l))) return true;
  return allFiles(ctx).some((f) =>
    /cookies\(\)\s*\.\s*set\s*\(|res\.cookie\s*\(|setCookie\s*\(|set_cookie\s*\(|Set-Cookie|httpOnly\s*[:=]\s*(?:true|True)/.test(
      f.content,
    ),
  );
}

/**
 * CSRF defences.
 *
 * SameSite counts. It is the defence that actually holds for a browser client,
 * and it is the one a deployer forgets; a CSRF token alone with
 * `SameSite=None` is not protection.
 */
function hasCsrfDefence(ctx: ScanContext): boolean {
  // Every mainstream session library sets SameSite=Lax (or Strict) by default,
  // which is a working CSRF defence for a browser client.
  const sessionLibs = [
    'next-auth',
    '@auth/core',
    'lucia',
    'better-auth',
    '@clerk/nextjs',
    '@clerk/clerk-sdk-node',
    'iron-session',
    'remix-auth',
  ];
  if (sessionLibs.some((l) => ctx.project.dependencyNames.has(l))) return true;

  return allFiles(ctx).some((f) =>
    /csrf|csurf|sameSite\s*:\s*['"](?:lax|strict)['"]|SameSite\s*=\s*(?:Lax|Strict)|csrfToken|double\.submit|assertSameOrigin|verifyOrigin|checkOrigin|validateOrigin/i.test(
      f.content,
    ),
  );
}

function countMutatingRoutes(ctx: ScanContext): number {
  let n = 0;
  for (const path of ctx.project.apiRoutes) {
    const file = filesWithExts(ctx, ext(path)).find((f) => f.path === path);
    if (!file) continue;
    if (STATE_CHANGING.test(file.content)) n++;
  }
  return n;
}

function hasAuthLibrary(ctx: ScanContext): boolean {
  return ['next-auth', '@auth/core', 'lucia', 'better-auth', '@clerk/nextjs', '@clerk/clerk-sdk-node', 'passport', 'jsonwebtoken', 'jose', 'next-auth'].some((l) =>
    ctx.project.dependencyNames.has(l),
  );
}

/**
 * True when a Next.js `middleware.ts` actually guards the API surface.
 *
 * Both halves are required: a middleware that only touches `/` leaves `/api`
 * open, and one that never inspects the session authenticates nothing. Checking
 * for the file alone produced false negatives; checking for both narrows it to
 * middleware that is doing the job.
 */
function middlewareGuardsApi(ctx: ScanContext): boolean {
  const middleware = allFiles(ctx).find((f) => /(^|\/)middleware\.(ts|js|tsx|jsx)$/.test(f.path));
  if (!middleware) return false;
  const source = middleware.content;
  // Every way middleware obtains a session: the cookie helper, the request
  // cookie accessor, a session library, or a bearer header.
  const readsSession =
    /\bcookies\s*\(\s*\)|req\.cookies|getServerSession|\bauth\s*\(|getToken|next-auth|NextAuth|authorization/i.test(
      source,
    );
  if (!readsSession) return false;
  // A matcher that names `/api` explicitly, or omits one entirely (Next.js
  // middleware with no matcher runs on every path including `/api`).
  const matcher = /matcher\s*:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  const coversApi = !matcher || /\/api|\*\*/.test(matcher);
  return coversApi;
}

/**
 * True for a Next.js App Router or Pages route handler.
 *
 * These are the routes where the auth question is sharpest: Next.js does not
 * add authentication for you, and a generated `route.ts` very often does not
 * call it. Middleware still counts (checked separately).
 */
function isNextRoute(file: SourceFile): boolean {
  if (!/(^|\/)(app|src\/app)\//.test(file.path)) return false;
  if (!/(^|\/)(route|page|middleware)\.(ts|tsx|js|jsx)$/.test(file.path)) return false;
  // Skip admin and auth routes, which are the authentication surface itself.
  return !/(^|\/)(auth|login|signin|signup|session|webhook)/.test(file.path);
}

function hasAuthCheck(ctx: ScanContext, file: SourceFile): boolean {
  const patterns =
    /getServerSession|auth\(\)|getSession|getToken|requireAuth|isAuthenticated|withAuth|currentUser|req\.user|request\.user|@login_required|Depends\([^)]*(?:current_user|get_current_user|auth)|clerkClient|getAuth\(|verifyToken|jwt\.verify|passport\.authenticate/;
  if (patterns.test(file.content)) return true;

  // Next.js App Router: a route that never calls `auth()` or reads a session is
  // not authenticated. `next-auth` in the dependencies proves nothing on its
  // own -- the route still has to invoke it.
  // Next.js middleware runs before every route, so a route that relies on it
  // is protected even though the handler itself contains no auth call. That is
  // the normal pattern, and flagging it was the rule's largest source of false
  // positives on AI-built Next.js apps.
  if (isNextRoute(file) && middlewareGuardsApi(ctx)) return true;
  // Framework middleware that guards the whole surface. In Next.js, middleware
  // runs before every matching route, so a session check there covers handlers
  // that do not repeat it -- which is the normal, correct pattern.
  for (const f of allFiles(ctx)) {
    if (!/(^|\/)(?:middleware|auth)\.(ts|js|mjs|py)$/.test(f.path)) continue;

    // A 401/403 returned from middleware is the strongest possible signal.
    const rejectsUnauthenticated = /(?:status|statusCode)\s*:\s*(?:401|403)\b|status\((?:401|403)\)|Unauthorized|unauthenticated/i.test(f.content);
    // A session read: `cookies()`, `req.session`, `getServerSession()`.
    const readsSession =
      /cookies?\s*[.(]|req\.session|request\.session|getToken|getSession|\bauth\s*\(|getServerSession|currentUser|getUserSession/i.test(
        f.content,
      );
    if (!rejectsUnauthenticated && !readsSession) continue;

    // Unless the matcher explicitly excludes /api, a middleware check covers
    // the API routes. An explicit `/api` mention also counts as intent.
    const excludesApi =
      /matcher\s*[:=][\s\S]{0,200}?ignore|exclude.*\/api/i.test(f.content) &&
      !/\/api/.test(f.content.replace(/ignore[\s\S]{0,120}/i, ''));
    if (excludesApi) continue;

    return true;
  }
  return false;
}

function isRouteHandler(file: SourceFile): boolean {
  return /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=|app\.(get|post|put|patch|delete)\s*\(|router\.(get|post|put|patch|delete)\s*\(|@(?:app|router)\.(get|post|put|patch|delete)\s*\(/.test(
    file.content,
  );
}
