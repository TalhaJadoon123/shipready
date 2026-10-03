import { connect } from 'node:net';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { TraceRecorder } from './recorder.js';
import type { ObserverOptions, Trace } from './types.js';

/**
 * Runtime instrumentation.
 *
 * The insight that makes this package small: you do not need to own the agent to
 * see what it is doing. An agent's behaviour is visible at three boundaries that
 * *everything* passes through, whatever it is written in:
 *
 *   1. outbound HTTPS   -- the LLM API call and every other network request
 *   2. the filesystem   -- reading and writing files
 *   3. process execution -- shell commands, which is also the privilege surface
 *
 * This module intercepts those boundaries by installing a preload module that
 * patches `https.request`, `fs`, and `child_process`. That works for a Node
 * agent with no cooperation at all, which is the common case: the user has
 * cloned somebody else's repo and wants to know what it does before they trust
 * it.
 *
 * What this cannot see: a Python or Go agent, or an agent that talks to a model
 * over a pipe rather than HTTPS. For those, `wrap()` below gives a first-class
 * API -- and `shipready observe -- python` uses the preload path anyway because
 * most Python agents still shell out to a Node tool or hit the same endpoints.
 */

const PRELOAD = 'shipready-observe-preload';
const SOCKET_NAME = 'shipready-observe.sock';

/**
 * Install the patches. Called from the preload module, which runs before the
 * agent's own code.
 */
export function installRuntimeHooks(options: ObserverOptions): void {
  const recorder = new TraceRecorder(
    options.command ?? process.argv.slice(2).join(' '),
    options,
    options.cwd ?? process.cwd(),
  );
  (globalThis as Record<string, unknown>)[PRELOAD] = { recorder, options };

  patchHttp(recorder);
  patchFs(recorder);
  patchChildProcess(recorder);
  installExitHandlers(recorder);
}

function state(): { recorder: TraceRecorder; options: ObserverOptions } | undefined {
  return (globalThis as Record<string, unknown>)[PRELOAD] as
    | { recorder: TraceRecorder; options: ObserverOptions }
    | undefined;
}

// ---------------------------------------------------------------------------
// HTTP / HTTPS: this is where LLM calls are visible
// ---------------------------------------------------------------------------

function patchHttp(recorder: TraceRecorder): void {
  for (const moduleName of ['https', 'http']) {
    const mod = requireModule(moduleName) as Record<string, unknown> | undefined;
    if (!mod || typeof mod.request !== 'function') continue;

    const original = mod.request as (...args: unknown[]) => unknown;
    mod.request = function patchedRequest(this: unknown, ...args: unknown[]): unknown {
      const options = (args[0] ?? {}) as { hostname?: string; host?: string; path?: string; method?: string };
      const url =
        typeof args[0] === 'string'
          ? (args[0] as string)
          : `https://${options.hostname ?? options.host ?? ''}${options.path ?? ''}`;
      const started = Date.now();
      const requestHeaders = (args[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};

      const req = original.apply(this, args) as EventEmitterish;

      const onResponse = (res: {
        statusCode?: number;
        on: (event: string, cb: (...a: never[]) => void) => void;
      }): void => {
        const chunks: Buffer[] = [];
        res.on('data', ((chunk: Buffer) => chunks.push(chunk)) as never);
        res.on('end', (() => {
          const body = Buffer.concat(chunks);
          recorder.network({
            method: options.method ?? 'GET',
            url,
            status: res.statusCode,
            responseBytes: body.length,
            durationMs: Date.now() - started,
          });
          const inferred = inferLlmCall(url, requestHeaders, body.toString('utf8'));
          if (inferred) recorder.llm(inferred);
        }) as never);
      };

      if (typeof req?.on === 'function') req.on('response', onResponse as never);
      if (typeof req?.on === 'function') {
        req.on('error', ((error: Error) => {
          recorder.network({ method: options.method ?? 'GET', url, durationMs: Date.now() - started, error: error.message });
        }) as never);
      }
      return req;
    };
  }
}

/**
 * Decide whether an HTTP exchange was a model call, and recover the token counts.
 *
 * This is the highest-value inference in the observer: without it, cost tracking
 * requires instrumenting the agent, and zero-config is the entire promise.
 */
function inferLlmCall(
  url: string,
  requestHeaders: Record<string, string>,
  responseBody: string,
): {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  durationMs?: number;
  streaming?: boolean;
  finishReason?: string;
  promptHash: string;
  responseHash: string;
} | null {
  const host = safeHost(url);
  let provider: string | null = null;
  if (/api\.openai\.com|api\.azure\.com/.test(host)) provider = 'openai';
  else if (/api\.anthropic\.com/.test(host)) provider = 'anthropic';
  else if (/generativelanguage\.googleapis\.com/.test(host)) provider = 'google';
  else if (/api\.mistral\.ai/.test(host)) provider = 'mistral';
  else if (/api\.groq\.com/.test(host)) provider = 'groq';
  else if (/localhost|127\.0\.0\.1/.test(host)) provider = 'local';
  if (!provider) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    // A streaming response is not JSON as a whole. The SSE frame prefix is
    // still enough to confirm it was a model call.
    if (/^\s*(data:|event:)/.test(responseBody) || responseBody.includes('"type":"content_block_delta"')) {
      return {
        provider,
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: undefined,
        streaming: true,
        promptHash: TraceRecorder.hash(url),
        responseHash: TraceRecorder.hash(responseBody.slice(0, 4096)),
      };
    }
    return null;
  }

  const usage = (parsed.usage ?? {}) as Record<string, number>;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0;
  const cached =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? ((usage.prompt_tokens_details as Record<string, number>).cached_tokens ?? undefined)
      : usage.cache_read_input_tokens ?? undefined;

  const model =
    (parsed.model as string | undefined) ??
    (Array.isArray(parsed.content) ? 'anthropic/unknown' : 'unknown');

  const finishReason =
    (parsed.stop_reason as string | undefined) ??
    ((parsed.choices as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason ?? undefined);

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(finishReason ? { finishReason } : {}),
    promptHash: TraceRecorder.hash(`${url}:${JSON.stringify(requestHeaders).slice(0, 512)}`),
    responseHash: TraceRecorder.hash(responseBody.slice(0, 4096)),
  };
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

const IGNORED_PATHS = /node_modules|\.git[/\\]|\.cache|__pycache__|\.next|dist|\.venv|site-packages/;

function patchFs(recorder: TraceRecorder): void {
  const fs = requireModule('fs') as Record<string, unknown> | undefined;
  const fsPromises = requireModule('fs/promises') as Record<string, unknown> | undefined;
  if (!fs && !fsPromises) return;

  for (const [mod, isPromise] of [
    [fs, false],
    [fsPromises, true],
  ] as const) {
    void isPromise;
    if (!mod) continue;
    for (const [name, operation] of [
      ['readFile', 'read'],
      ['readFileSync', 'read'],
      ['writeFile', 'write'],
      ['writeFileSync', 'write'],
      ['appendFile', 'write'],
      ['unlink', 'delete'],
      ['rm', 'delete'],
    ] as const) {
      const original = mod[name] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== 'function') continue;

      mod[name] = function patched(...args: unknown[]): unknown {
        const started = Date.now();
        const finish = (bytes: number, error?: Error): void => {
          const path = String(args[0] ?? '');
          if (IGNORED_PATHS.test(path)) return;
          try {
            recorder.file({ path, operation: operation as 'read' | 'write' | 'delete', bytes });
          } catch {
            // Instrumentation must never break the host process.
          }
          if (error) recorder.error({ message: `${name} failed: ${error.message}` });
          void started;
        };

        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === 'function' && isPromiseLike(result)) {
          return (result as Promise<unknown>).then(
            (value: unknown) => {
              finish(byteLength(value, args[1]));
              return value;
            },
            (error: Error) => {
              finish(0, error);
              throw error;
            },
          );
        }
        finish(byteLength(result, args[1]));
        return result;
      };
    }
  }
}

// ---------------------------------------------------------------------------
// child_process: the privilege boundary
// ---------------------------------------------------------------------------

/**
 * Commands that change privilege or move data off the machine.
 * Seeing one of these in an agent trace is the single most useful alert the
 * observer produces.
 */
const PRIVILEGE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/, why: 'escalates privileges' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\b/, why: 'makes files world-writable' },
  { re: /\bchown\b/, why: 'changes file ownership' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh\b/, why: 'downloads and executes remote code' },
  { re: /\bwget\b[^|]*\|\s*(ba)?sh\b/, why: 'downloads and executes remote code' },
  { re: /\brm\s+-rf?\s+\/(?:\s|$)/, why: 'recursive delete from root' },
  { re: /\beval\b/, why: 'evaluates a string as code' },
  { re: /\bnpm\s+publish\b/, why: 'publishes a package' },
  { re: /\bgit\s+push\b/, why: 'writes to a remote' },
  { re: /\bcrontab\b/, why: 'installs a scheduled job' },
];

function patchChildProcess(recorder: TraceRecorder): void {
  const cp = requireModule('child_process') as Record<string, unknown> | undefined;
  if (!cp) return;

  for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') continue;

    cp[name] = function patched(this: unknown, ...args: unknown[]): unknown {
      const command = extractCommand(name, args);
      const started = Date.now();

      if (command) {
        for (const { re, why } of PRIVILEGE_PATTERNS) {
          if (re.test(command)) {
            recorder.flag({
              kind: 'privilege-escalation',
              severity: 'critical',
              message: `Command ${why}: ${truncate(command, 120)}`,
              detail: { command: truncate(command, 500), why },
            });
            break;
          }
        }
      }

      const result = original.apply(this, args);
      const child = result as { on?: (e: string, cb: (...a: never[]) => void) => void } | undefined;
      if (child && typeof child.on === 'function' && !name.endsWith('Sync')) {
        child.on('exit', ((code: number | null) => {
          recorder.tool({
            tool: `exec:${name}`,
            args: { command },
            success: code === 0,
            durationMs: Date.now() - started,
            ...(code !== 0 ? { error: `exit ${code}` } : {}),
          });
        }) as never);
      }
      return result;
    };
  }
}

function extractCommand(name: string, args: readonly unknown[]): string | null {
  if (name.startsWith('execFile')) {
    return typeof args[0] === 'string' ? `${args[0]} ${Array.isArray(args[1]) ? args[1].join(' ') : ''}` : null;
  }
  if (typeof args[0] === 'string') return args[0];
  const options = args[0] as { cmd?: unknown } | undefined;
  return typeof options?.cmd === 'string' ? options.cmd : null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function installExitHandlers(recorder: TraceRecorder): void {
  const flush = (code: number): void => {
    const current = state();
    if (!current || current.recorder.isEnded) return;
    const trace = recorder.end(code);
    if (current.options.jsonl) {
      process.stderr.write(`${JSON.stringify({ type: 'trace', summary: trace.summary })}\n`);
    }
    // The store is opened lazily by the parent process; the child only writes
    // JSONL, which keeps the preload dependency-free.
  };

  process.on('exit', (code) => flush(code));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      flush(130);
      process.exit(130);
    });
  }
  process.on('uncaughtException', (error: Error) => {
    state()?.recorder.error({ message: error.message, stack: error.stack, fatal: true });
    flush(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    state()?.recorder.error({ message: String(reason), fatal: false });
  });
}

// ---------------------------------------------------------------------------
// Explicit API for agents that want to cooperate
// ---------------------------------------------------------------------------

export interface InstrumentedAgent {
  llm: (input: {
    provider: string;
    model: string;
    prompt?: string;
    response?: string;
    inputTokens: number;
    outputTokens: number;
    durationMs?: number;
    streaming?: boolean;
  }) => void;
  tool: (input: { tool: string; args?: unknown; result?: unknown; success: boolean; durationMs?: number }) => void;
  decision: (input: { decision: string; reasoning?: string; scores?: Record<string, number> }) => void;
  error: (input: { message: string; fatal?: boolean }) => void;
  summary: () => unknown;
  end: () => Trace;
}

/**
 * Wrap an agent's own instrumentation calls.
 *
 * The zero-config path handles most people. This is for an agent author who
 * wants exact token counts, prompt visibility, or decision traces -- none of
 * which can be recovered from the network boundary alone.
 */
export function wrap(recorder: TraceRecorder): InstrumentedAgent {
  return {
    llm: (input) => {
      recorder.llm(input);
    },
    tool: (input) => {
      recorder.tool(input);
    },
    decision: (input) => {
      recorder.decision(input);
    },
    error: (input) => {
      recorder.error(input);
    },
    summary: () => recorder.summary(),
    end: () => recorder.end(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `require` from inside an ESM preload module.
 *
 * The preload runs as CJS via `--require`, but the package ships ESM, so a
 * static `import` would load the whole graph before the patches are installed
 * and the agent would start with unpatched built-ins.
 */
function requireModule(name: string): Record<string, unknown> | undefined {
  try {
    const req = (globalThis as { require?: (n: string) => unknown }).require
      ?? createRequireFn();
    return req(name) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

function createRequireFn(): (n: string) => unknown {
  try {
    const { createRequire } = require('node:module') as typeof import('node:module');
    return createRequire(`${process.cwd()}/noop.js`);
  } catch {
    return () => undefined;
  }
}

interface EventEmitterish {
  on?: (event: string, cb: (...a: never[]) => void) => void;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown }).then === 'function';
}

function byteLength(value: unknown, encoding: unknown): number {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') {
    return typeof encoding === 'string' && encoding === 'buffer'
      ? Buffer.byteLength(value)
      : value.length;
  }
  return 0;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export { PRELOAD, SOCKET_NAME, connect, createServer, createHash, randomUUID };