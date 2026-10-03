import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, filesWithExts, SERVER_EXTS } from './helpers.js';
import type { ScanContext } from '../../types.js';

/**
 * The AI-specific category.
 *
 * These are the failure modes that only exist because a language model wrote
 * the code, and that no general-purpose SAST rule was written for. They are
 * also the checks most likely to be unknown to the person who shipped the
 * code, which is why the descriptions explain the mechanism rather than just
 * naming it.
 */
const LLM_SDK = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'ai', '@ai-sdk/openai', '@ai-sdk/anthropic', 'cohere-ai', 'mistralai', 'ollama', '@azure/openai', 'langchain', '@langchain/core', 'llamaindex'];
const LLM_CALL = /(chat\.completions\.create|messages\.create|generateContent|completions\.create|invoke\s*\(|generate\s*\(|chat\.complete|\.completion\s*\(|createCompletion|textGenerationModel\.generateText)/;

/**
 * Per-request output caps, across providers.
 *
 * Matched as whole property names so `maxTokens: 1024` inside a schema counts
 * as well as `max_tokens` on the call itself.
 */
const TOKEN_CAP_RE = /\b(?:max_tokens|maxTokens|max_output_tokens|max_completion_tokens|maxOutputTokens|num_predict|max_output_tokens)\b/;

export const aiSpecificRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/ai-specific/no-token-limits',
      name: 'No token or rate limit on LLM calls',
      category: 'ai-specific',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.85,
      effortMinutes: 60,
      fixable: true,
      description:
        'The app calls an LLM with no per-request token cap, no per-user quota, and no global spend ceiling. One bug, one determined user, or one scraped endpoint is enough to run up a five-figure bill in a night. Model providers do have hard rate limits, but they are orders of magnitude above what is safe for your margins.',
      remediation:
        'Cap `max_tokens` on every call. Add a per-user daily token budget enforced in your own datastore, checked before the call. Add a hard monthly spend alarm at the provider. Return a clear 429 rather than letting the provider reject you. This single change is worth more than every other item in this category.',
      compliance: [COMPLIANCE.llmTop10Unbounded, COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A8, COMPLIANCE.nis2Art21],
      cwe: 'CWE-770',
      owasp: 'LLM10',
      tags: ['ai-cost', 'abuse', 'launch-blocker', 'bill-risk'],
      references: [
        'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
        'https://platform.openai.com/docs/guides/rate-limits',
      ],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      // Two independent controls: a per-request token cap at each call site, and
      // a quota elsewhere. The finding fires when either is missing, and the
      // evidence says which.
      const capped = sites.filter((s) => TOKEN_CAP_RE.test(s.content));
      const quota = hasQuotaOrBudget(ctx);
      if (capped.length === sites.length && quota) return;

      const uncapped = sites.filter((s) => !TOKEN_CAP_RE.test(s.content));
      const target = uncapped[0] ?? sites[0]!;
      let evidence: string;
      if (uncapped.length === 0) {
        evidence = `every LLM call sets a token cap, but there is no per-user quota and no spend ceiling`;
      } else if (quota) {
        evidence = `${uncapped.length} of ${sites.length} LLM call site(s) set no max_tokens`;
      } else {
        evidence = `${sites.length} LLM call site(s) with no max_tokens, no per-user quota and no spend ceiling`;
      }
      yield emit({
        path: target.path,
        line: target.line,
        snippet: target.snippet,
        evidence,
        data: { callSites: sites.length, capped: capped.length, quota },
        tags: ['ai-cost', 'abuse', 'launch-blocker', 'bill-risk'],
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-prompt-injection-guard',
      name: 'Untrusted input reaches the model unsanititised',
      category: 'ai-specific',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.75,
      effortMinutes: 60,
      fixable: false,
      description:
        'User-controlled text is concatenated into a prompt with no boundary marking and no injection defence. Any content the model later reads -- a web page, an email, a stored document, a tool result -- becomes an instruction channel. This is the vulnerability that makes an agent dangerous rather than merely wrong.',
      remediation:
        'Separate instructions from data with explicit delimiters and state that content inside them is data, not instructions. Treat model output as untrusted everywhere downstream. Restrict tool permissions so a successful injection cannot reach destructive actions. Add an adversarial test set: prompts that try to override your instructions, and assert the model still refuses.',
      compliance: [COMPLIANCE.llmTop10PromptInjection, COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A8],
      cwe: 'CWE-77',
      owasp: 'LLM01',
      tags: ['prompt-injection', 'agent', 'launch-blocker', 'ai-security'],
      references: ['https://owasp.org/www-project-top-10-for-large-language-model-applications/'],
    },
    function* (ctx, emit) {
      for (const site of llmCallSites(ctx)) {
        // Read a wide window of real source around the call, so a system prompt
        // declared above and an injection guard far below are both visible.
        // Widened to the whole file: the call and its input can be far apart.
        const window = site.content;

        // A guard: explicit delimiters, an instruction to treat content as data,
        // sanitisation, or a schema check before the call.
        if (/(sanitize|sanitise|escape|strip|scrub|untrusted|delimit|redact|prompt.?inject)/i.test(window)) continue;
        if (/<\s*(user_?content|user_?input|document|untrusted_input|user_message)/i.test(window)) continue;
        if (/(?:isUserInput|userControlled|fromUser|sanitizeForPrompt|wrapUntrusted)\s*\(/.test(window)) continue;

        // Untrusted origin: anything read off the request, however it is
        // destructured. `const { text } = await req.json()` is as untrusted as
        // `req.body.text`, and is what almost every generated handler does.
        const rawUser =
          /\b(?:req|request)\.(?:body|query|params|json|formData|text)\b/.test(window) ||
          /\b(?:ctx|context)\.(?:request|query|params)\b/.test(window) ||
          /\buserInput\b|\buser_message\b|\buserMessage\b|\buser_query\b|\buserQuery\b|\bmessageFromUser\b/.test(window) ||
          /\bgetUserMessage\s*\(/.test(window);

        if (!rawUser) continue;

        // `await req.json()` alone is not an injection surface: the value only
        // matters if it reaches the prompt.
        const reachesPrompt =
          /(?:messages|content|input|prompt|body|text|query)\s*[:=]\s*(?:[a-zA-Z_$][\w$]*)/.test(window) ||
          /\$\{[^}]*\}/.test(window) ||
          /\+\s*(?:text|input|prompt|message|content|query)\b/.test(window);
        if (!reachesPrompt) continue;

        yield emit({
          path: site.path,
          line: site.line,
          snippet: site.snippet,
          evidence:
            'user-supplied value interpolated into a model prompt with no delimiting or sanitisation; any content the model later reads becomes an instruction channel',
          data: { callSite: site.snippet.slice(0, 60) },
          tags: ['prompt-injection', 'agent', 'launch-blocker', 'ai-security'],
        });
      }
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-output-validation',
      name: 'Model output trusted without validation',
      category: 'ai-specific',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 45,
      fixable: false,
      description:
        'Model output is consumed as if it were a function return: parsed with `JSON.parse` and no schema check, or written straight to the database. Models hallucinate structure, omit required fields, and return prose where you expected JSON. A missing field then flows into a SQL query.',
      remediation:
        'Validate output against a schema with the same rigour as input: `z.object({...}).safeParse(response)`. Retry once with the validation error in the prompt on failure, then fail explicitly. Never pass model output to a query, a shell, or a file path without validation.',
      compliance: [COMPLIANCE.llmTop10SensitiveInfo, COMPLIANCE.euAiActArticle15, COMPLIANCE.owaspA05],
      owasp: 'LLM02',
      tags: ['output-validation', 'ai-safety'],
      references: ['https://owasp.org/www-project-top-10-for-large-language-model-applications/'],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      if (hasOutputValidation(ctx)) return;
      const target = sites[0]!;
      yield emit({
        path: target.path,
        line: target.line,
        snippet: target.snippet,
        evidence: `${sites.length} LLM call site(s) with no schema validation, output parsing guard or retry on malformed output`,
        data: { callSites: sites.length },
        tags: ['output-validation', 'ai-safety'],
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-model-fallback',
      name: 'Hard dependency on a single model provider',
      category: 'ai-specific',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.75,
      effortMinutes: 90,
      fixable: false,
      description:
        'The application depends on one provider with no fallback path. Provider outages, rate limits and regional blocks all become your outage. For an AI product this is the availability risk that is easiest to forget and most expensive to explain.',
      remediation:
        'Wrap the provider behind your own interface with at least two implementations. On a rate-limit or 5xx, fall back to the second provider with a shorter timeout and, if both fail, return a cached or template response rather than an error. Degrade visibly: tell the user the answer may be degraded.',
      compliance: [COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A8],
      tags: ['resilience', 'vendor-lock-in'],
      references: [],
    },
    function* (ctx, emit) {
      const providers = LLM_SDK.filter((d) => ctx.project.dependencyNames.has(d));
      if (providers.length === 0) return;
      if (hasFallbackLogic(ctx)) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `single LLM provider dependency (${providers.slice(0, 3).join(', ')}) with no fallback or retry across providers`,
        data: { providers },
        effortMinutes: 90,
      });
    },
    (ctx) => LLM_SDK.some((d) => ctx.project.dependencyNames.has(d)),
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-cost-tracking',
      name: 'No token or cost tracking for AI usage',
      category: 'ai-specific',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 60,
      fixable: true,
      description:
        'Token usage is not recorded. You cannot tell which feature is expensive, which user is costing you money, what your unit economics are, or what an attack is doing to your bill. Run `shipready observe` on the agent path to get this without writing code.',
      remediation:
        'Record `model`, `promptTokens`, `completionTokens`, `estimatedCost` and `userId` for every call. Aggregate by day, model and feature. Set a daily budget alert. This is the single most valuable AI observability signal and it takes about an hour to add.',
      compliance: [COMPLIANCE.euAiActArticle12, COMPLIANCE.llmTop10Unbounded],
      tags: ['ai-cost', 'observability'],
      references: [],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      if (hasCostTracking(ctx)) return;
      yield emit({
        path: sites[0]!.path,
        line: sites[0]!.line,
        evidence: `${sites.length} LLM call site(s) with no token counting, cost calculation or usage recording`,
        data: { callSites: sites.length },
        tags: ['ai-cost', 'observability'],
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-eval-suite',
      name: 'AI feature shipped with no evaluation set',
      category: 'ai-specific',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 180,
      fixable: false,
      description:
        'An LLM feature has no evaluation set. You cannot tell whether a prompt change made it better or worse, whether a model upgrade regressed it, or whether it still works at all. You are shipping to users and finding out from their complaints.',
      remediation:
        'Build 30-50 representative cases with known-good expected behaviour, including the ones that currently fail. Run them in CI on every prompt or model change. Track accuracy, refusal rate and latency. This is what turns prompt engineering from guesswork into engineering, and it is a hard requirement under the EU AI Act for high-risk systems.',
      compliance: [COMPLIANCE.euAiActArticle15, COMPLIANCE.euAiActArticle17, COMPLIANCE.iso27001A8],
      tags: ['ai-eval', 'quality-gate', 'eu-ai-act'],
      references: ['https://platform.openai.com/docs/guides/evals'],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      if (hasEvalSuite(ctx)) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `${sites.length} LLM call site(s) with no eval harness, golden dataset or regression test for model behaviour`,
        data: { callSites: sites.length },
        effortMinutes: 180,
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/no-pii-redaction-for-ai',
      name: 'Personal data sent to a model provider without redaction',
      category: 'ai-specific',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.6,
      effortMinutes: 60,
      fixable: false,
      description:
        'A prompt includes personal data with no redaction. Data sent to a model provider has left your system: it may be logged, retained, or reviewed, is outside your GDPR processor agreement unless you have a DPA in place, and is a cross-border transfer requiring a legal basis. You cannot delete it later.',
      remediation:
        'Redact or pseudonymise before the call: map names and emails to stable internal ids, strip anything not needed for the answer. Use the provider zero-data-retention option where available. Put a data processing agreement in place. Document the fields sent and the lawful basis, in your ROPA.',
      compliance: [COMPLIANCE.gdprArticle5, COMPLIANCE.gdprArticle32, COMPLIANCE.gdprArticle35, COMPLIANCE.euAiActArticle10],
      tags: ['gdpr', 'pii', 'launch-blocker', 'ai-privacy'],
      references: ['https://gdpr-info.eu/art-35-gdpr/'],
    },
    function* (ctx, emit) {
      const piiFields = /\b(email|phone|address|first_?name|last_?name|full_?name|date_?of_?birth|dob|ssn|passport|iban|address_line|city|postcode|credit_?card|customer_?name)\b/i;
      for (const site of llmCallSites(ctx)) {
        const window = site.content.slice(Math.max(0, site.index - 1200), site.index + 600);
        if (/(redact|pseudonymi[sz]e|anonymi[sz]e|maskPii|scrub|sanitiz)/i.test(window)) continue;
        const field = piiFields.exec(window);
        if (!field?.[1]) continue;
        // Only flag when the PII field is being assembled into the prompt, not
        // mentioned in a nearby type definition.
        if (!new RegExp(`(user|customer|profile|contact|address|account)\\.?\\s*${field[1]}`, 'i').test(window) && !new RegExp(`\\$\\{[^}]*${field[1]}`, 'i').test(window)) continue;
        yield emit({
          path: site.path,
          line: site.line,
          snippet: site.snippet,
          evidence: `personal field \`${field[1]}\` included in a model prompt with no redaction or pseudonymisation`,
          data: { field: field[1] },
          tags: ['gdpr', 'pii', 'launch-blocker', 'ai-privacy'],
        });
      }
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/system-prompt-leak-risk',
      name: 'System prompt sent through a user-visible channel',
      category: 'ai-specific',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.55,
      effortMinutes: 30,
      fixable: false,
      description:
        'The system or developer prompt is logged, echoed in an API response, or sent to the client. System prompts contain your business rules and tool definitions, and users will find them: they are shown in the model UI by default in most providers.',
      remediation:
        'Keep the system prompt server-side. Do not log it. Treat it as a configuration value with versioning, not a secret to rely on -- assume it is public, and put nothing in it that must stay private. Enforce the boundary in a policy test.',
      compliance: [COMPLIANCE.llmTop10SensitiveInfo],
      tags: ['prompt-leak', 'ai-security'],
      references: [],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      const sys = /\bsystem\s*:\s*[`"']/.exec(sites[0]!.content);
      if (!sys) return;
      const window = sites[0]!.content.slice(Math.max(0, sys.index - 500), sys.index + 1200);
      const leaked = /(console\.(log|error|warn)\s*\([^)]*system|logger\.\w+\([^)]*systemPrompt|res\.(json|send)\([^)]*system|return\s+[^;]*systemPrompt|NEXT_PUBLIC_\w*PROMPT)/i.test(window);
      if (!leaked) return;
      yield emit({
        path: sites[0]!.path,
        line: 1,
        evidence: 'system prompt appears to be logged or returned to the client',
        severity: 'medium',
        impact: 'degradation',
        confidenceScale: 0.7,
        effortMinutes: 30,
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/hardcoded-model-in-source',
      name: 'Model identifier hardcoded rather than configured',
      category: 'ai-specific',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.8,
      effortMinutes: 20,
      fixable: true,
      description:
        'Model names are hardcoded at call sites. Changing model means a code change and a deploy, which means you cannot A/B a new model, cannot pin a stable version, and cannot roll back quickly when an upstream model is quietly deprecated.',
      remediation:
        'Put model ids in configuration. Keep a registry of supported models with a default, and resolve it at runtime so you can switch by environment variable. Pin dated model versions rather than floating aliases.',
      compliance: [COMPLIANCE.euAiActArticle15],
      tags: ['configuration', 'rollout'],
      references: [],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      const hardcoded = sites.filter((s) => /model\s*:\s*["'][a-z0-9][\w.\-]*(?:-\d{8})?["']/.test(s.content));
      if (hardcoded.length === 0) return;
      if (hardcoded.length < sites.length) return;
      yield emit({
        path: hardcoded[0]!.path,
        line: hardcoded[0]!.line,
        evidence: `model identifier hardcoded at all ${hardcoded.length} call site(s) instead of read from configuration`,
        severity: 'low',
        impact: 'cosmetic',
        effortMinutes: 20,
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),

  defineRule(
    {
      id: 'readiness/ai-specific/streaming-without-cancellation',
      name: 'Streaming model call with no abort or cancellation',
      category: 'ai-specific',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 40,
      fixable: false,
      description:
        'A streaming model call has no abort signal. When a user navigates away, the connection stays open and the generation continues to completion: you pay for tokens nobody sees, and you hold a connection on the provider.',
      remediation:
        'Pass an `AbortSignal` that the request abort triggers (`req.signal`, or an `AbortController` tied to client disconnect). Cancel on unmount in React with an effect cleanup. Most providers support cancellation and will stop billing.',
      compliance: [COMPLIANCE.llmTop10Unbounded],
      tags: ['ai-cost', 'resources'],
      references: [],
    },
    function* (ctx, emit) {
      const sites = llmCallSites(ctx);
      if (sites.length === 0) return;
      const streaming = sites.filter((s) => /stream\s*:\s*true|\.stream\(\)|createStream|streamText|streaming/.test(s.content));
      if (streaming.length === 0) return;
      const withAbort = streaming.filter((s) => /abort|signal|AbortController/.test(s.content));
      if (withAbort.length === streaming.length) return;
      yield emit({
        path: streaming[0]!.path,
        line: streaming[0]!.line,
        snippet: streaming[0]!.snippet,
        evidence: `${streaming.length - withAbort.length} of ${streaming.length} streaming call site(s) with no abort signal -- abandoned requests keep billing`,
        data: { streamingSites: streaming.length },
      });
    },
    (ctx) => llmCallSites(ctx).length > 0,
  ),
];

// ---------------------------------------------------------------------------

interface CallSite {
  path: string;
  line: number;
  index: number;
  snippet: string;
  content: string;
}

function llmCallSites(ctx: ScanContext): CallSite[] {
  const out: CallSite[] = [];
  const hasSdk = LLM_SDK.some((d) => ctx.project.dependencyNames.has(d));
  if (!hasSdk) return out;
  for (const file of filesWithExts(ctx, ...SERVER_EXTS, '.py', '.go')) {
    if (/(^|\/)(test|tests|__tests__|fixtures|node_modules)\//.test(file.path)) continue;
    for (const hit of file.matchCode(LLM_CALL)) {
      const line = file.line(hit.line);
      if (/(test|spec|mock|fixture)/i.test(file.path)) continue;
      out.push({ path: file.path, line: hit.line, index: hit.index, snippet: line.slice(0, 160), content: file.content });
    }
  }
  return out;
}

function hasQuotaOrBudget(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /dailyLimit|daily_limit|tokenBudget|token_budget|monthlyBudget|quota|rateLimit.*user|userRateLimit|usageLimit|MAX_TOKENS_PER|checkQuota|consumeQuota|spendLimit/i.test(
      f.content,
    ),
  );
}

function hasOutputValidation(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /\.safeParse\s*\(|\.parse\s*\(\s*\w*(?:Schema|schema)|parseCompletion|validateOutput|outputSchema|responseSchema|response_format\s*:|response_format\s*=|withStructuredOutput|responseMimeType/i.test(
      f.content,
    ),
  );
}

function hasFallbackLogic(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /fallbackModel|fallback_model|providerFallback|withFallback|retryWithFallback|secondaryProvider|switchProvider|catch.{0,80}(?:openai|anthropic|gemini|model)|RateLimitError|APIConnectionError|overloaded_error/i.test(
      f.content,
    ),
  );
}

function hasCostTracking(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /promptTokens|completionTokens|prompt_tokens|completion_tokens|inputTokens|outputTokens|estimatedCost|estimated_cost|totalCost|llm_usage|LlmUsage|recordUsage|trackUsage|costUsd|cost_usd/i.test(
      f.content,
    ),
  );
}

function hasEvalSuite(ctx: ScanContext): boolean {
  if (ctx.files().some((f) => /(^|\/)(evals?|evaluations?)\//.test(f) || /\.eval\.[jt]sx?$/.test(f) || /(^|\/)golden/.test(f))) return true;
  if (['@openai/evals', 'promptfoo', 'langsmith', 'braintrust', 'deepeval', 'ragas', 'instructor', 'openai'].some((d) => ctx.project.dependencyNames.has(d)) && ctx.filter((f) => /\.eval\.[jt]sx?$|eval/.test(f)).length > 0) return true;
  return allFiles(ctx).some((f) => /assertGrounded|expectAccuracy|runEvals|evalDataset|goldenDataset/i.test(f.content));
}