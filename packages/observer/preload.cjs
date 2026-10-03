/**
 * ShipReady observer preload.
 *
 * Loaded with `node --require shipready-observe/preload.cjs`. It patches the
 * three boundaries every agent crosses -- HTTPS, the filesystem and process
 * execution -- and writes one JSON line per event to stderr.
 *
 * Two constraints shape this file:
 *
 *  1. **It must install synchronously.** `node -e "process.exit(1)"` exits
 *     before an async dynamic `import()` of an ESM module can resolve, which
 *     would mean the fastest-exiting agents produce no trace at all. Every
 *     patch below is therefore plain CommonJS with no top-level await.
 *
 *  2. **It must never break the host.** Each hook is wrapped so that an
 *     exception inside the observer cannot propagate into the agent. A tool
 *     that breaks the thing it is observing is worse than no tool.
 *
 * All aggregation happens in the parent process, so this file stays small and
 * dependency-free: it is a sensor, not an analysis engine.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

// --- Event emission --------------------------------------------------------

let seq = 0;
const startedAt = Date.now();
let ended = false;
let exitCode;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function emit(event) {
  try {
    event.seq = seq++;
    event.ts = new Date().toISOString();
    event.offsetMs = Date.now() - startedAt;
    process.stderr.write(JSON.stringify(event) + '\n');
  } catch {
    // Never let instrumentation failure reach the agent.
  }
}

function safe(fn, name) {
  return function (...args) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      try {
        emit({ kind: 'error', name, message: String((error && error.message) || error) });
      } catch {}
      throw error;
    }
  };
}

// --- HTTPS: this is where model calls are visible --------------------------

const LLM_HOSTS = [
  [/api\.openai\.com/, 'openai', /(^|\/)openai\/(.*)$/],
  [/api\.anthropic\.com/, 'anthropic', /^anthropic\/(.*)$/],
  [/generativelanguage\.googleapis\.com/, 'google', /^google\/(.*)$/],
  [/api\.mistral\.ai/, 'mistral', /^mistral\/(.*)$/],
  [/api\.groq\.com/, 'groq', /^groq\/(.*)$/],
];

function detectModelCall(url, responseBody) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  for (const [pattern, provider, modelRe] of LLM_HOSTS) {
    if (!pattern.test(host)) continue;

    // A streaming response is SSE frames rather than one JSON document.
    if (/^\s*(data:|event:)/.test(responseBody) || responseBody.includes('content_block_delta')) {
      return {
        provider,
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        streaming: true,
        promptHash: hash(url),
        responseHash: hash(responseBody.slice(0, 4096)),
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      return null;
    }

    const usage = parsed.usage || {};
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0;
    const cached =
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
        ? usage.prompt_tokens_details.cached_tokens
        : usage.cache_read_input_tokens;

    let model = parsed.model;
    if (!model && Array.isArray(parsed.content)) {
      const m = modelRe.exec('anthropic/claude-3-5-sonnet');
      model = m ? m[2] : 'unknown';
    }

    const finishReason =
      parsed.stop_reason ||
      (Array.isArray(parsed.choices) ? parsed.choices[0] && parsed.choices[0].finish_reason : undefined);

    return {
      provider,
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      cachedInputTokens: cached,
      finishReason,
      promptHash: hash(url),
      responseHash: hash(responseBody.slice(0, 4096)),
    };
  }
  return null;
}

function patchHttpModule(mod) {
  const original = mod.request;
  mod.request = function patchedRequest(...args) {
    const first = args[0];
    const options = typeof first === 'string' || typeof first === 'url' ? {} : first || {};
    const url =
      typeof first === 'string'
        ? first
        : `${options.protocol || 'https:'}//${options.hostname || options.host || ''}${options.path || ''}`;
    const method = options.method || 'GET';
    const startedAt = Date.now();

    const request = original.apply(this, args);

    request.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        emit({
          kind: 'network',
          name: `${method} ${hostOf(url)}`,
          method,
          host: hostOf(url),
          status: res.statusCode,
          responseBytes: body.length,
          durationMs: Date.now() - startedAt,
          data: {},
        });
        const llm = detectModelCall(url, body.toString('utf8'));
        if (llm) {
          emit({
            kind: 'llm',
            name: llm.model,
            provider: llm.provider,
            model: llm.model,
            inputTokens: llm.inputTokens,
            outputTokens: llm.outputTokens,
            cachedInputTokens: llm.cachedInputTokens,
            streaming: llm.streaming,
            finishReason: llm.finishReason,
            promptHash: llm.promptHash,
            responseHash: llm.responseHash,
            durationMs: Date.now() - startedAt,
            data: {},
          });
        }
      });
    });

    request.on('error', (error) => {
      emit({
        kind: 'network',
        name: `${method} ${hostOf(url)}`,
        method,
        host: hostOf(url),
        durationMs: Date.now() - startedAt,
        error: String(error && error.message),
        data: {},
      });
    });

    return request;
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).replace(/^\/\//, '').split(/[/?#]/)[0] || String(url);
  }
}

patchHttpModule(http);
patchHttpModule(https);

// --- Filesystem ------------------------------------------------------------

const IGNORED = /node_modules|[\\/]\.git[\\/]|\.cache|__pycache__|[\\/]\.next[\\/]|site-packages/;

function bytesOf(value, encoding) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return 0;
}

function patchFsModule(mod, isPromiseApi) {
  const methods = [
    ['readFile', 'read'],
    ['readFileSync', 'read'],
    ['writeFile', 'write'],
    ['writeFileSync', 'write'],
    ['appendFile', 'write'],
    ['unlink', 'delete'],
    ['unlinkSync', 'delete'],
    ['rm', 'delete'],
    ['rmSync', 'delete'],
  ];

  for (const [name, operation] of methods) {
    const original = mod[name];
    if (typeof original !== 'function') continue;

    mod[name] = safe(function (...args) {
      const filePath = String(args[0] === undefined ? '' : args[0]);
      const interesting = filePath !== '' && !IGNORED.test(filePath);
      const started = Date.now();
      const encoding = args[2];

      const record = (bytes, error) => {
        if (!interesting) return;
        emit({
          kind: 'file',
          name: filePath,
          path: filePath,
          operation,
          bytes: bytes || 0,
          durationMs: Date.now() - started,
          error,
          data: {},
        });
      };

      const result = original.apply(this, args);
      if (isPromiseApi && result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            record(bytesOf(value, encoding));
            return value;
          },
          (error) => {
            record(0, String(error && error.message));
            throw error;
          },
        );
      }
      record(bytesOf(result, encoding));
      return result;
    }, name);
  }
}

patchFsModule(fs, false);
patchFsModule(fsp, true);

// --- child_process: the privilege boundary ---------------------------------

const PRIVILEGE_PATTERNS = [
  [/\bsudo\b/, 'escalates privileges'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b/, 'makes files world-writable'],
  [/\bchown\b/, 'changes file ownership'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, 'downloads and executes remote code'],
  [/\brm\s+-rf?\s+\/(\s|$)/, 'recursive delete from root'],
  [/\beval\b/, 'evaluates a string as code'],
  [/\bnpm\s+publish\b/, 'publishes a package'],
  [/\bgit\s+push\b/, 'writes to a remote'],
  [/\bcrontab\b/, 'installs a scheduled job'],
];

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : value.slice(0, max - 1) + '...';
}

function checkPrivilege(command) {
  if (!command) return;
  for (const [pattern, why] of PRIVILEGE_PATTERNS) {
    if (pattern.test(command)) {
      emit({
        kind: 'error',
        name: 'privilege-escalation',
        message: `Command ${why}: ${truncate(command, 120)}`,
        fatal: true,
        data: { anomaly: 'privilege-escalation', command: truncate(command, 500), why },
      });
      return;
    }
  }
}

function patchChildProcess() {
  const methods = ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync'];
  for (const name of methods) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;

    childProcess[name] = safe(function (...args) {
      let command;
      if (name.startsWith('execFile')) {
        command = typeof args[0] === 'string' ? args[0] : undefined;
      } else if (typeof args[0] === 'string') {
        command = args[0];
      } else if (args[0] && typeof args[0] === 'object' && typeof args[0].cmd === 'string') {
        command = args[0].cmd;
      }

      checkPrivilege(command);

      const started = Date.now();
      const result = original.apply(this, args);
      const child = result;

      if (child && typeof child.on === 'function' && !name.endsWith('Sync')) {
        child.on('exit', (code) => {
          emit({
            kind: 'tool',
            name: `exec:${name}`,
            tool: `exec:${name}`,
            argumentsHash: hash(String(command || '')),
            success: code === 0,
            durationMs: Date.now() - started,
            error: code === 0 ? undefined : `exit ${code}`,
            data: {},
          });
        });
      }
      return result;
    }, name);
  }
}

patchChildProcess();

// --- Programmatic bridge ---------------------------------------------------

/**
 * A minimal recorder API exposed to the agent's own code.
 *
 * Zero-config capture sees the network, filesystem and process boundaries. It
 * cannot see an LLM call made over a pipe rather than HTTPS, nor an agent's
 * internal decision trace. An agent that wants those reported calls
 * `globalThis.__shipreadyObserve` (or `require('shipready-observe/bridge')`),
 * which is what makes the difference between "I saw three network calls" and
 * "I know what it spent".
 */
globalThis.__shipreadyObserve = {
  llm(input) {
    emit({
      kind: 'llm',
      name: input.model || 'unknown',
      provider: input.provider || 'unknown',
      model: input.model || 'unknown',
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens,
      durationMs: input.durationMs,
      streaming: input.streaming,
      finishReason: input.finishReason,
      promptHash: hash(String(input.prompt ?? '')),
      responseHash: hash(String(input.response ?? '')),
      error: input.error,
      data: {},
    });
  },
  tool(input) {
    emit({
      kind: 'tool',
      name: input.tool,
      tool: input.tool,
      argumentsHash: hash(safeStringify(input.args)),
      success: input.success !== false,
      durationMs: input.durationMs,
      error: input.error,
      data: {},
    });
  },
  decision(input) {
    emit({
      kind: 'decision',
      name: String(input.decision ?? '').slice(0, 80),
      decision: input.decision ?? '',
      reasoningHash: hash(String(input.reasoning ?? '')),
      scores: input.scores,
      durationMs: input.durationMs,
      data: {},
    });
  },
  network(input) {
    emit({
      kind: 'network',
      name: `${input.method || 'GET'} ${hostOf(input.url || '')}`,
      method: input.method || 'GET',
      host: hostOf(input.url || ''),
      status: input.status,
      requestBytes: input.requestBytes,
      responseBytes: input.responseBytes,
      durationMs: input.durationMs,
      error: input.error,
      data: {},
    });
  },
  error(input) {
    emit({
      kind: 'error',
      name: String(input.message ?? '').slice(0, 80),
      message: input.message ?? 'unknown error',
      stack: input.stack,
      fatal: Boolean(input.fatal),
      data: {},
    });
  },
};

function safeStringify(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// --- Session lifecycle -----------------------------------------------------

function flush(code) {
  if (ended) return;
  ended = true;
  exitCode = code;
  emit({
    kind: 'session',
    name: 'end',
    phase: 'end',
    command: process.argv.slice(2).join(' '),
    exitCode: code,
    pid: process.pid,
    cwd: process.cwd(),
    data: {},
  });
}

emit({
  kind: 'session',
  name: 'start',
  phase: 'start',
  command: process.argv.slice(2).join(' '),
  pid: process.pid,
  cwd: process.cwd(),
  data: {},
});

process.on('exit', flush);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    flush(130);
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  emit({
    kind: 'error',
    name: 'uncaught-exception',
    message: error.message,
    stack: error.stack,
    fatal: true,
    data: {},
  });
  flush(1);
});
process.on('unhandledRejection', (reason) => {
  emit({
    kind: 'error',
    name: 'unhandled-rejection',
    message: String(reason && reason.message ? reason.message : reason),
    fatal: false,
    data: {},
  });
});