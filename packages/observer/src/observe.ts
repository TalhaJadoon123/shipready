import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceRecorder } from './recorder.js';
import { TraceStore } from './store.js';
import { createRequire } from 'node:module';
import type { ObserverOptions, Trace } from './types.js';

/**
 * `shipready observe -- <command>`.
 *
 * The contract: one command, zero configuration, and it never gets in the way.
 *
 * How it works: the child process runs with `--require <preload>`, which patches
 * the boundaries it crosses. The parent reads the child's JSONL from stderr and
 * writes it to SQLite. Nothing is proxied, nothing is MITM'd, no certificate is
 * installed, and the agent runs at full speed.
 *
 * If the preload cannot be installed -- a non-Node agent, a shell script, a
 * statically linked binary -- the command still runs and still reports what it
 * can see from the parent (exit code, duration, output volume), and says so
 * plainly rather than pretending to have instrumented something.
 */
export interface ObserveOptions extends Partial<ObserverOptions> {
  command: string;
  dbPath?: string;
  cwd?: string;
  costBudget?: number;
  costPerEvent?: number;
  captureContent?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
  tui?: boolean;
  timeoutMs?: number;
}

export interface ObserveResult {
  trace: Trace | null;
  exitCode: number;
  /** True when the child actually ran under instrumentation. */
  instrumented: boolean;
  /** Why not, when it was not instrumented. */
  reason?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The preload module.
 *
 * Written as a self-contained CJS file with no imports beyond Node built-ins:
 * it runs before the agent's own code, so the fewer things that can fail here,
 * the better. It requires the built package lazily and swallows every error.
 */
const PRELOAD_SOURCE = `
// ShipReady observer preload. Installed by \`shipready observe\`.
// Patches http/https, fs and child_process to record agent behaviour.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let recorder = null;
let options = {};

async function boot() {
  const entry = process.env.SHIPREADY_OBSERVER_ENTRY;
  if (!entry) return;
  try {
    const mod = await import(pathToFileURL(entry).href);
    options = JSON.parse(process.env.SHIPREADY_OBSERVER_OPTIONS || '{}');
    mod.installRuntimeHooks({ ...options, command: process.argv.slice(2).join(' ') });
    recorder = globalThis['shipready-observe-preload'].recorder;
  } catch (error) {
    // Failing to instrument must never stop the agent from running.
    process.stderr.write(JSON.stringify({
      type: 'shipready-observer-error',
      message: error && error.message ? error.message : String(error),
    }) + '\\n');
  }
}
boot();
`;

function ensurePreload(): string {
  const dir = join(here, '..', '.runtime');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'preload.cjs');
  writeFileSync(file, PRELOAD_SOURCE, 'utf8');
  return file;
}

export async function observe(options: ObserveOptions): Promise<ObserveResult> {
  const cwd = options.cwd ?? process.cwd();
  const dbPath = options.dbPath ?? join(cwd, '.shipready', 'traces.db');
  const commandLine = options.command.trim();
  if (!commandLine) {
    return {
      trace: null,
      exitCode: 2,
      instrumented: false,
      reason: 'no command given',
      stdout: '',
      stderr: '',
      durationMs: 0,
    };
  }

  const argv = parseCommand(commandLine);
  const [program, ...args] = argv;
  if (!program) {
    return {
      trace: null,
      exitCode: 2,
      instrumented: false,
      reason: `could not parse command: ${commandLine}`,
      stdout: '',
      stderr: '',
      durationMs: 0,
    };
  }

  const preload = ensurePreload();
  const observerOptions: ObserverOptions = {
    dbPath,
    cwd,
    ...(options.captureContent !== undefined ? { captureContent: options.captureContent } : {}),
    ...(options.costBudget !== undefined ? { costBudget: options.costBudget } : {}),
    ...(options.costPerEvent !== undefined ? { costPerEvent: options.costPerEvent } : {}),
    jsonl: true,
  };

  const isNode = isNodeProgram(program);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SHIPREADY_OBSERVER_ENTRY: join(here, 'index.js'),
    SHIPREADY_OBSERVER_OPTIONS: JSON.stringify({
      captureContent: observerOptions.captureContent ?? false,
      costBudget: observerOptions.costBudget ?? 0,
      costPerEvent: observerOptions.costPerEvent ?? 0,
      cwd,
    }),
    SHIPREADY_ACTIVE: '1',
  };

  const nodeArgs = isNode
    ? ['--require', preload, program, ...args]
    : [program, ...args];

  const childProgram = isNode ? process.execPath : program!;
  const started = Date.now();

  const { code, signal, stdout, stderr, traceLines } = await runChild(
    childProgram,
    nodeArgs,
    childEnv,
    cwd,
    options.timeoutMs ?? 0,
  );

  // Reconstruct the trace from the child's JSONL.
  const trace = traceLines.length > 0 ? buildTraceFromLines(traceLines, commandLine, cwd, started) : null;

  let instrumented = false;
  let reason: string | undefined;
  if (!isNode) {
    reason = `${program} is not a Node program, so the filesystem, network and process hooks could not be installed. Run it under Node, or use the programmatic API for exact numbers.`;
  } else if (traceLines.length === 0) {
    const observerError = stderr.match(/"type":"shipready-observer-error","message":"([^"]*)"/);
    reason = observerError?.[1]
      ? `instrumentation failed to load: ${observerError[1]}`
      : 'the child produced no observer events. It may have exited before the preload ran.';
  } else {
    instrumented = true;
  }

  const exitCode = code ?? (signal ? 128 : 1);
  const durationMs = Date.now() - started;

  if (trace) {
    trace.summary.exitCode = exitCode;
    trace.summary.durationMs = durationMs;
    if (trace.summary.endedAt === undefined) trace.summary.endedAt = new Date().toISOString();
  }

  if (trace) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = new TraceStore(dbPath);
    store.save(trace);
    store.close();
  }

  // Surface the child's own stderr, minus the observer's JSONL.
  const cleanStderr = stripObserverLines(stderr);

  return { trace, exitCode, instrumented, ...(reason ? { reason } : {}), stdout, stderr: cleanStderr, durationMs };
}

function runChild(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  traceLines: unknown[];
}> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const traceLines: unknown[] = [];
    let timedOut = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{"type":"')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.type === 'session' || parsed.type === 'llm' || parsed.type === 'tool' || parsed.type === 'network' || parsed.type === 'file' || parsed.type === 'decision' || parsed.type === 'error' || parsed.type === 'anomaly') {
            traceLines.push(parsed);
            continue;
          }
          if (parsed.type === 'trace') {
            traceLines.push({ type: 'summary', summary: parsed.summary });
            continue;
          }
        } catch {
          // Not ours.
        }
        process.stderr.write(`${line}\n`);
      }
    });

    child.on('error', (error: Error) => {
      if (timer) clearTimeout(timer);
      stderr += `spawn failed: ${error.message}\n`;
      resolve({ code: null, signal: null, stdout, stderr, traceLines });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) stderr += `\n[shipready] timed out after ${timeoutMs} ms\n`;
      resolve({ code, signal, stdout, stderr, traceLines });
    });
  });
}

/**
 * Rebuild a trace from the child's JSONL.
 *
 * The child emits finished events, not a trace object, because it has no
 * knowledge of the parent's intent. Assembling here keeps the preload small.
 */
function buildTraceFromLines(
  lines: readonly unknown[],
  command: string,
  cwd: string,
  startedAt: number,
): Trace | null {
  const events: Trace['events'] = [];
  const anomalies: Trace['summary']['anomalies'] = [];

  for (const line of lines) {
    const record = line as Record<string, unknown>;
    if (record.type === 'summary') {
      const summary = record.summary as Trace['summary'];
      for (const a of summary.anomalies ?? []) anomalies.push(a);
      continue;
    }
    const { type, ...event } = record;
    void type;
    events.push({ ...(event as unknown as Trace['events'][number]) });
  }

  if (events.length === 0) return null;

  events.sort((a, b) => a.seq - b.seq);

  const summary: Trace['summary'] = {
    id: `obs-${startedAt.toString(36)}`,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    command,
    cwd,
    totalCostUsd: 0,
    costComplete: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    llmCalls: 0,
    toolCalls: 0,
    fileOps: 0,
    networkRequests: 0,
    decisions: 0,
    errors: 0,
    toolDistribution: {},
    byModel: {},
    hosts: [],
    anomalies,
  };

  const hosts = new Set<string>();
  const toolCounts: Record<string, number> = {};

  for (const event of events) {
    switch (event.kind) {
      case 'llm': {
        summary.llmCalls++;
        summary.totalInputTokens += event.inputTokens;
        summary.totalOutputTokens += event.outputTokens;
        summary.totalCachedTokens += event.cachedInputTokens ?? 0;
        summary.totalCostUsd += event.costUsd;
        if (!event.costPriced) summary.costComplete = false;
        const key = event.model;
        const existing = summary.byModel[key] ?? {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          priced: event.costPriced,
        };
        existing.calls++;
        existing.inputTokens += event.inputTokens;
        existing.outputTokens += event.outputTokens;
        existing.costUsd = round(existing.costUsd + event.costUsd, 6);
        existing.priced = existing.priced && event.costPriced;
        summary.byModel[key] = existing;
        break;
      }
      case 'tool': {
        summary.toolCalls++;
        toolCounts[event.tool] = (toolCounts[event.tool] ?? 0) + 1;
        break;
      }
      case 'file':
        summary.fileOps++;
        break;
      case 'network':
        summary.networkRequests++;
        hosts.add(event.host);
        break;
      case 'decision':
        summary.decisions++;
        break;
      case 'error':
        summary.errors++;
        break;
      default:
        break;
    }
  }
  summary.toolDistribution = toolCounts;
  summary.hosts = [...hosts];
  summary.totalCostUsd = round(summary.totalCostUsd, 6);

  return { summary, events, version: 1 };
}

function stripObserverLines(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{"type":"')) return true;
      try {
        const parsed = JSON.parse(trimmed) as { type: string };
        return parsed.type === 'shipready-observer-error';
      } catch {
        return true;
      }
    })
    .join('\n')
    .trimEnd();
}

/**
 * Split a command string into argv.
 *
 * Handles single and double quotes and backslash escapes, which is enough for
 * every agent command anyone actually types. It deliberately does not attempt
 * to be a shell: `shipready observe -- node app.js` should run `node app.js`, not
 * hand a string to `/bin/sh`.
 */
export function parseCommand(input: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\\' && quote !== "'" && i + 1 < input.length) {
      current += input[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current.length > 0) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current.length > 0) argv.push(current);
  return argv;
}

function isNodeProgram(program: string): boolean {
  const base = program.toLowerCase();
  if (base === 'node' || base === 'nodejs' || base.endsWith('\\node.exe') || base.endsWith('/node')) return true;
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs')) return true;
  if (base.endsWith('.ts')) return true;
  return false;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Recorders for callers embedding the observer in their own agent. */
export function createRecorder(options: ObserverOptions): TraceRecorder {
  return new TraceRecorder(options.command ?? 'embedded', options, options.cwd);
}

export { createRequire };