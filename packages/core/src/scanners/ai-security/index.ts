import { defineRule, rulesToScanners, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, filesWithExts, JS_EXTS, SERVER_EXTS } from '../readiness/helpers.js';
import type { ScanContext } from '../../types.js';

/**
 * Scoring: exploitation likelihood x impact, mapped to a 0-100 risk score.
 *
 * The multiplication is deliberate -- it stops the engine from shouting about
 * a low-impact issue just because it is easy to detect, and it stops it
 * ignoring a catastrophic issue because the pattern is rare.
 */
function riskScore(likelihood: number, impact: number): number {
  return Math.round(Math.max(0, Math.min(1, likelihood)) * Math.max(0, Math.min(1, impact)) * 100);
}

function severityForRisk(risk: number): 'critical' | 'high' | 'medium' | 'low' {
  if (risk >= 70) return 'critical';
  if (risk >= 45) return 'high';
  if (risk >= 25) return 'medium';
  return 'low';
}

const AI_SDKS = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'ai', '@ai-sdk/openai', '@ai-sdk/anthropic', 'langchain', '@langchain/core', 'llamaindex', 'ollama'];
const LLM_CALL = /(chat\.completions\.create|messages\.create|generateContent|completions\.create|invoke\s*\(|generateText|streamText|\.completion\s*\()/;

export const aiSecurityRules: Rule[] = [
  defineRule(
    {
      id: 'ai-security/agent-tool-permissions',
      name: 'Tool granted destructive filesystem or shell access',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.8,
      effortMinutes: 60,
      fixable: false,
      description:
        'An agent tool is registered with broad or destructive capability -- shell execution, unrestricted filesystem access, or arbitrary network egress. An agent driven by model output executes what the output says. A single successful prompt injection through any untrusted input gives an attacker those capabilities under your identity.',
      remediation:
        'Replace a general-purpose tool with narrow, parameterised ones: `read_file(path)` scoped to a workspace root, `run_command(cmd)` restricted to an allowlist. Enforce the boundary in the tool implementation, not in the prompt. Assume the model will eventually be talked into calling the tool in an unintended way.',
      compliance: [COMPLIANCE.llmTop10ExcessiveAgency, COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A5],
      cwe: 'CWE-250',
      owasp: 'LLM06',
      tags: ['agent', 'mcp', 'launch-blocker', 'excessive-agency'],
      references: ['https://owasp.org/www-project-top-10-for-large-language-model-applications/'],
    },
    function* (ctx, emit) {
      if (!hasAiSdk(ctx) && !hasMcp(ctx)) return;
      for (const file of allFiles(ctx)) {
        if (/(^|\/)(node_modules|vendor|tests?|fixtures)/.test(file.path)) continue;
        const risky: { re: RegExp; label: string; likelihood: number; impact: number }[] = [
          { re: /child_process\s*\.\s*(exec|execSync)\s*\(|execa\s*\(|shell\s*:\s*true\s*\)/, label: 'shell execution', likelihood: 0.9, impact: 0.95 },
          { re: /tools\s*:\s*\[\s*\{[^}]*(?:exec|bash|shell|command|terminal|run_command)/i, label: 'shell tool definition', likelihood: 0.85, impact: 0.95 },
          { re: /readFile\w*\s*\([^)]*(?:req\.(body|query|params)|params\.|args\.|input\.)/, label: 'file read with dynamic path', likelihood: 0.8, impact: 0.8 },
          { re: /writeFile\w*\s*\([^)]*(?:req\.(body|query|params)|params\.|args\.|input\.)/, label: 'file write with dynamic path', likelihood: 0.85, impact: 0.9 },
          { re: /rmSync\s*\(|rm\s+-rf|shutil\.rmtree|fs\.unlink\w*\(/, label: 'file deletion', likelihood: 0.75, impact: 0.9 },
          { re: /new\s+(?:Function|Function)\s*\(\s*(?:args|params|input|code|command)/, label: 'dynamic code execution from tool arguments', likelihood: 0.9, impact: 0.95 },
        ];
        for (const { re, label, likelihood, impact } of risky) {
          const hit = file.matchNoComments(re)[0];
          if (!hit) continue;
          if (/(allowlist|allowedPaths|workspace|sandbox|jail|restricted|SKIP_DIRS|resolveWithin)/.test(file.content.slice(Math.max(0, hit.index - 400), hit.index + 800))) continue;
          const risk = riskScore(likelihood, impact);
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `agent-reachable ${label} with no allowlist or sandboxing (risk ${risk}/100)`,
            data: { capability: label, riskScore: risk, likelihood, impact },
            severity: severityForRisk(risk),
            impact: 'blocker',
            effortMinutes: 60,
          });
        }
      }
    },
    (ctx) => hasAiSdk(ctx) || hasMcp(ctx),
  ),

  defineRule(
    {
      id: 'ai-security/mcp-no-auth',
      name: 'MCP server exposed without authentication',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.8,
      effortMinutes: 60,
      fixable: false,
      description:
        'An MCP server is bound to a network interface with no authentication. Anyone who can reach the port can list your tools, call them, and act with the full authority you granted them -- reading files, sending messages, moving money.',
      remediation:
        'Bind to localhost for local use. If it must be remote, put it behind an authenticating gateway with per-client identity, require TLS, and grant each client a scoped token rather than a shared one. Treat the tool list as an API surface and review it as one.',
      compliance: [COMPLIANCE.owaspA07, COMPLIANCE.llmTop10ExcessiveAgency, COMPLIANCE.iso27001A5, COMPLIANCE.soc2CC6],
      cwe: 'CWE-306',
      owasp: 'A07:2021',
      tags: ['mcp', 'launch-blocker'],
      references: ['https://modelcontextprotocol.io/specification'],
    },
    function* (ctx, emit) {
      if (!hasMcp(ctx)) return;
      const files = filesWithExts(ctx, ...JS_EXTS, '.ts', '.py');
      for (const file of files) {
        if (!/McpServer|Server\s*\(|FastMCP|mcp\.server|MCPServer|createServer\s*\(/.test(file.content)) continue;
        if (/(ssrf-protected|auth|authenticate|apiKey|bearer|token|middleware|verifyClient)/.test(file.content)) continue;
        const binds = /\b(?:app|server|mcp)\.listen\s*\(\s*(?:["']0\.0\.0\.0["']|PORT|process\.env\.PORT|\d{4,5})/.exec(file.content);
        yield emit({
          path: file.path,
          line: 1,
          snippet: binds?.[0] ?? '',
          evidence: binds
            ? `MCP server listens on a network port with no authentication layer (${binds[0]})`
            : 'MCP server constructed with no authentication layer',
          data: { bind: binds?.[0] ?? 'unknown' },
        });
      }
    },
    (ctx) => hasMcp(ctx),
  ),

  defineRule(
    {
      id: 'ai-security/mcp-tool-injection',
      name: 'Tool description accepts unsanitised input',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: false,
      description:
        'A tool description or parameter schema is built from untrusted input. Tool descriptions are part of the model context, so attacker-controlled text there is a prompt injection that arrives before the user says anything.',
      remediation:
        'Keep tool descriptions static. Validate parameters against a schema before use, and keep untrusted content out of the tool metadata entirely. If a description must be dynamic, constrain it to an enum and cap its length.',
      compliance: [COMPLIANCE.llmTop10PromptInjection, COMPLIANCE.llmTop10ExcessiveAgency],
      owasp: 'LLM01',
      tags: ['mcp', 'prompt-injection'],
      references: ['https://modelcontextprotocol.io/specification'],
    },
    function* (ctx, emit) {
      if (!hasMcp(ctx) && !hasAiSdk(ctx)) return;
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py')) {
        for (const hit of file.matchNoComments(
          /description\s*[:=]\s*(?:[a-zA-Z_$][\w$]*\s*(?:,|\)|\})|`[^`]*\$\{|["'][^"']*["']\s*\+)/g,
        )) {
          if (/^description\s*[:=]\s*["'`][^"'`$]*["'`]?\s*[,\)\}]/.test(hit.text)) continue;
          if (file.hasExplanatoryCommentNear(hit.line, ['static', 'const', 'from spec'])) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: 'tool description appears to be constructed from a runtime value -- attacker-controlled text can reach the model context',
            confidenceScale: 0.75,
          });
        }
      }
    },
    (ctx) => hasMcp(ctx) || hasAiSdk(ctx),
  ),

  defineRule(
    {
      id: 'ai-security/client-db-access',
      name: 'Database accessed directly from client code',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 90,
      fixable: false,
      description:
        'A client component imports a database client. Either the connection string is exposed to the browser, giving anyone full database credentials, or the code bundles a server-only dependency into the client and leaks the schema.',
      remediation:
        'Remove the database import from the client. Move the data access behind an API route or a server action. Add `server-only` to the module that creates the client so the bundler fails loudly if it is ever imported from the browser.',
      compliance: [COMPLIANCE.owaspA02, COMPLIANCE.owaspA01],
      cwe: 'CWE-668',
      owasp: 'A02:2021',
      tags: ['client', 'secrets', 'launch-blocker', 'ai-specific'],
      references: ['https://nextjs.org/docs/app/building-your-application/rendering/server-components'],
    },
    function* (ctx, emit) {
      const clientFiles = filesWithExts(ctx, '.tsx', '.jsx', '.vue', '.svelte').filter((f) => !/use client|use client['"]/.test(f.content));
      for (const file of clientFiles) {
        const hit = file.matchNoComments(
          /from\s+["'](?:@prisma\/client|prisma|@\/lib\/(?:db|prisma)|drizzle[\w/]*|mongoose|pg|sqlite3|better-sqlite3|typeorm|@supabase\/supabase-js|firebase\/firestore|appwrite)["']|require\(["'](?:@prisma\/client|prisma|pg|mongoose)["']\)/g,
        )[0];
        if (!hit) continue;
        if (/^["']use client["']|^\s*["']use client["']/.test(file.line(1))) continue;
        if (/import\s+["']server-only["']/.test(file.content)) continue;
        yield emit({
          path: file.path,
          line: hit.line,
          snippet: hit.text,
          evidence: `database client imported into client component \`${hit.text}\` -- credentials and schema ship to the browser`,
        });
      }
    },
  ),

  defineRule(
    {
      id: 'ai-security/over-permissive-cors-in-production',
      name: 'Development CORS configuration likely to ship to production',
      category: 'security',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.6,
      effortMinutes: 30,
      fixable: true,
      description:
        'CORS origins include localhost, or are derived from an environment variable with a permissive fallback. The localhost value gets added so the dev server works, and then it reaches production where it weakens the policy or masks a missing configuration.',
      remediation:
        'Make the origin allowlist explicit per environment and fail closed when it is unset. Do not merge localhost into the production list. Assert in a test that the production origin list contains no localhost entries.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-942',
      tags: ['cors', 'environment', 'ai-specific'],
      references: [],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...SERVER_EXTS, '.py', '.go')) {
        for (const hit of file.matchNoComments(/localhost:\d{4}|127\.0\.0\.1:\d{4}/g)) {
          const isDev = /process\.env\.NODE_ENV\s*!==?\s*['"]production['"]|is_dev|DEBUG\b|development/.test(file.content);
          if (isDev) continue;
          const inOriginList = /origin|allow_origins|cors|ALLOWED_ORIGIN/i.test(
            file.content.slice(Math.max(0, hit.index - 200), hit.index + 200),
          );
          if (!inOriginList) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: 'localhost origin in the CORS allowlist outside a development-only branch',
            confidenceScale: 0.75,
            effortMinutes: 30,
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'ai-security/missing-ai-endpoint-rate-limit',
      name: 'AI endpoint has no rate limit while other routes do',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.75,
      effortMinutes: 30,
      fixable: true,
      description:
        'Rate limiting exists but is not applied to the model-calling route. This is the specific shape of the AI cost-exploit bug: the developer added rate limiting in week one, added the AI feature in week six, and did not register the new route with the limiter.',
      remediation:
        'Apply the limiter to the whole API surface by default rather than per-route, and add a stricter tier for endpoints that call a model. Track spend per user id, not only per IP -- one attacker behind a rotating proxy pool still costs you money per authenticated user.',
      compliance: [COMPLIANCE.llmTop10Unbounded, COMPLIANCE.owaspA07],
      owasp: 'LLM10',
      tags: ['ai-cost', 'rate-limit', 'launch-blocker'],
      references: [],
    },
    function* (ctx, emit) {
      const aiRoutes = filesWithExts(ctx, ...SERVER_EXTS).filter((f) => LLM_CALL.test(f.content));
      if (aiRoutes.length === 0) return;
      const limiterConfigured = allFiles(ctx).some((f) => /rateLimit|rate_limit|RateLimiter|express-rate-limit|@upstash\/ratelimit|throttl/i.test(f.content));
      if (!limiterConfigured) return;
      const unprotected = aiRoutes.filter((f) => !/rateLimit|rate_limit|limiter|throttle/i.test(f.content));
      if (unprotected.length === 0) return;
      yield emit({
        path: unprotected[0]!.path,
        line: 1,
        snippet: unprotected[0]!.line(1),
        evidence: `${unprotected.length} model-calling route(s) with no rate limit applied, while rate limiting exists elsewhere`,
        data: { routes: unprotected.map((f) => f.path) },
      });
    },
    (ctx) => filesWithExts(ctx, ...SERVER_EXTS).some((f) => LLM_CALL.test(f.content)),
  ),

  defineRule(
    {
      id: 'ai-security/vector-store-public',
      name: 'Vector store endpoint appears publicly reachable',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: false,
      description:
        'A vector database client (Pinecone, Qdrant, Weaviate, pgvector) is configured in code with what appears to be a persistent endpoint. Vector stores are a favourite target: they hold the text of every document your users ever uploaded, and they are usually created without auth because the developer was only testing locally.',
      remediation:
        'Keep the vector store behind your API. Use short-lived, request-scoped credentials rather than a long-lived key in an environment variable. Treat vector data as personal data under GDPR -- it is derived from content users gave you.',
      compliance: [COMPLIANCE.gdprArticle32, COMPLIANCE.owaspA07, COMPLIANCE.euAiActArticle10],
      cwe: 'CWE-306',
      tags: ['rag', 'vector-db', 'pii', 'launch-blocker'],
      references: [],
    },
    function* (ctx, emit) {
      const vectorDeps = ['pinecone-client', '@pinecone-database/pinecone', '@qdrant/js-client-rest', 'weaviate-ts-client', 'chromadb', 'langchain-chroma', '@supabase/supabase-js'];
      const hits = vectorDeps.filter((d) => ctx.project.dependencyNames.has(d));
      if (hits.length === 0) return;
      for (const file of allFiles(ctx)) {
        const hit = file.matchNoComments(/https?:\/\/[a-z0-9-]+\.(?:pinecone\.io|qdrant\.io|cloud\.weaviate\.io|weaviate\.network)\.[a-z]+/g)[0];
        if (!hit) continue;
        if (/(apiKey|api_key|Authorization|Bearer|token)\s*[:=]/i.test(file.content.slice(Math.max(0, hit.index - 200), hit.index + 400))) continue;
        yield emit({
          path: file.path,
          line: hit.line,
          snippet: hit.text,
          evidence: `vector database endpoint (${hit.text}) configured without visible credentials in this file`,
          data: { client: hits },
        });
      }
    },
    (ctx) => ['pinecone-client', '@pinecone-database/pinecone', '@qdrant/js-client-rest', 'weaviate-ts-client', 'chromadb', 'langchain-chroma'].some((d) => ctx.project.dependencyNames.has(d)),
  ),

  defineRule(
    {
      id: 'ai-security/secret-in-client-bundle',
      name: 'Server-only dependency imported into client code',
      category: 'security',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.75,
      effortMinutes: 45,
      fixable: false,
      description:
        'A client component imports a server-only module. Depending on the bundler this either exposes a secret, inlines privileged code, or fails the build. The intent was almost always "this component needs data the server owns".',
      remediation:
        'Move the call behind an API route or server action and pass the result to the component as a prop. Add `import "server-only"` at the top of every module that must never reach the browser -- it converts a silent leak into a build error.',
      compliance: [COMPLIANCE.owaspA02],
      cwe: 'CWE-668',
      tags: ['client', 'secrets', 'nextjs', 'ai-specific'],
      references: ['https://nextjs.org/docs/app/building-your-application/rendering/server-components'],
    },
    function* (ctx, emit) {
      const serverOnly = ['server-only', 'stripe', '@stripe/stripe-js', 'firebase-admin', 'aws-sdk', '@aws-sdk/client-s3', 'jsonwebtoken', 'nodemailer', 'twilio', '@sendgrid/mail', 'prisma'];
      for (const file of filesWithExts(ctx, '.tsx', '.jsx', '.vue', '.svelte')) {
        if (/^\s*["']use client["']/m.test(file.content.slice(0, 200))) continue;
        for (const hit of file.matchNoComments(/from\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g)) {
          const spec = hit.match.replace(/.*["']([^"']+)["'].*/, '$1');
          if (!serverOnly.includes(spec)) continue;
          if (spec === '@stripe/stripe-js' || spec === 'stripe') continue; // client-safe variants exist
          if (/(^|\/)(\.|@\/)/.test(spec) && !/lib\/(db|prisma|server|auth)/.test(spec)) continue;
          if (/^server-only$/.test(spec)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `client component imports server-only module \`${spec}\``,
            data: { module: spec },
          });
        }
      }
    },
  ),
];

/** Scanners for every AI-security rule. */
export const aiSecurityScanners = rulesToScanners(aiSecurityRules);

// ---------------------------------------------------------------------------

function hasAiSdk(ctx: ScanContext): boolean {
  return AI_SDKS.some((d) => ctx.project.dependencyNames.has(d));
}

function hasMcp(ctx: ScanContext): boolean {
  return (
    ctx.project.dependencyNames.has('@modelcontextprotocol/sdk') ||
    allFiles(ctx).some((f) => /modelcontextprotocol|McpServer|FastMCP/.test(f.content))
  );
}