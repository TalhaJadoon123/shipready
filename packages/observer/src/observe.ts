import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { estimateCost } from './pricing.js';
import { humanUsd } from './util.js';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceRecorder } from './recorder.js';
import { TraceStore } from './store.js';
import { createRequire } from 'node:module';
import type { ObserverOptions, Trace, TraceEvent } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ObserveOptions extends Partial<ObserverOptions> {
  command: string;
  /** Stop the child after this long. 0 disables. */
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

/**
 * The preload module.
 *
 * Shipped as a checked-in CommonJS file rather than generated. It has to
 * install its patches synchronously -- `node -e "process.exit(1)"` exits before
 * an async dynamic import of an ESM module can resolve, so an agent that exits
 * fastest would produce no trace at all. A real `.cjs` file, `require`d by
 * `--require`, is the only form that guarantees synchronous installation.
 *
 * It carries no dependencies and writes one JSON line per event to stderr;
 * all aggregation happens in the parent process.
 */
function preloadPath(): string {
  const candidates = [
    // Running from source (ts, tests).
    join(here, '..', 'preload.cjs'),
    // Running from dist.
    join(here, '..', '..', 'preload.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'ShipReady observer preload not found. Reinstall @shipready/observer, or report this at https://github.com/shipreadyai/shipready/issues',
  );
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

  // The cwd matters: `parseCommand` resolves relative paths against it when
  // deciding whether a token is a program path broken by a space, and the child
  // is spawned from there rather than from ours.
  const argv = parseCommand(commandLine, cwd);
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

  const preload = preloadPath();
  const observerOptions: ObserverOptions = {
    dbPath,
    cwd,
    ...(options.captureContent !== undefined ? { captureContent: options.captureContent } : {}),
    ...(options.costBudget !== undefined ? { costBudget: options.costBudget } : {}),
    ...(options.costPerEvent !== undefined ? { costPerEvent: options.costPerEvent } : {}),
    jsonl: true,
  };
  // Budget alerting runs in the parent: the child has no recorder, so it cannot
  // know the running total.
  const costBudget = options.costBudget ?? 0;

  // Two shapes reach here: `node script.js` (the first token is the runtime) and
  // `script.js` (the first token is already a script). Only the former needs a
  // Node binary in front, and only the latter needs the script re-attached.
  const isNodeRuntime = isNodeProgram(program);
  const isScript = !isNodeRuntime && isNodeScript(program);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SHIPREADY_OBSERVER_OPTIONS: JSON.stringify({
      captureContent: observerOptions.captureContent ?? false,
      costBudget: observerOptions.costBudget ?? 0,
      costPerEvent: observerOptions.costPerEvent ?? 0,
      cwd,
    }),
    SHIPREADY_ACTIVE: '1',
  };

  // Three shapes reach here:
  //   `node agent.js`   the runtime is the first token; drop it, since the
  //                    child is spawned as execPath already.
  //   `agent.js`        a script invoked directly; Node has to run it.
  //   `python x.py`     not Node at all, so no preload.
  //
  // Note the non-Node branch passes `args` alone. `spawn` fills in `argv[0]`
  // from `childProgram` by itself, so repeating the program name turned
  // `sh -c "exit 0"` into `sh sh -c "exit 0"`: sh treated the second `sh` as a
  // script filename, failed to open it, and the caller saw exit 2 for a command
  // that succeeded. The agent's real exit code was unrecoverable from the
  // outside, which is the one thing `shipready observe` must never get wrong.
  const childProgram = isNodeRuntime || isScript ? process.execPath : program!;
  const childArgs =
    isNodeRuntime || isScript ? ['--require', preload, ...(isScript ? [program!] : []), ...args] : args;

  const started = Date.now();

  const { code, signal, stdout, stderr, traceLines } = await runChild(
    childProgram,
    childArgs,
    childEnv,
    cwd,
    options.timeoutMs ?? 0,
  );

  // Reconstruct the trace from the child's event stream. The id incorporates
  // the start time and pid so two runs never collide in the database.
  const traceId = `obs-${started.toString(36)}-${process.pid}`;
  const trace =
    traceLines.length > 0
      ? buildTraceFromLines(traceLines, commandLine, cwd, started, traceId, costBudget ?? 0)
      : null;

  let instrumented = false;
  let reason: string | undefined;
  if (!isNodeRuntime && !isScript) {
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
  traceLines: TraceEvent[];
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
    const traceLines: TraceEvent[] = [];
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
        if (!trimmed.startsWith('{"kind":')) {
          // The agent's own stderr: pass it through untouched.
          if (trimmed !== '') process.stderr.write(`${line}\n`);
          continue;
        }
        try {
          traceLines.push(JSON.parse(trimmed) as TraceEvent);
        } catch {
          // Malformed observer line: do not pass it through as if it were the
          // agent's output, because that would corrupt the trace stream.
          process.stderr.write(`${line}\n`);
        }
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

function buildTraceFromLines(
  lines: readonly TraceEvent[],
  command: string,
  cwd: string,
  startedAt: number,
  traceId: string,
  costBudget: number,
): Trace | null {
  const events: Trace['events'] = [];
  const anomalies: Trace['summary']['anomalies'] = [];

  // The preload emits events without ids; assign them here so replay and
  // compare can reference a specific event across runs.
  // `compare` can reference a specific event across runs.
  for (const line of lines) {
    if (!line.id) {
      const event = line as TraceEvent;
      events.push({
        ...event,
        id: createHash('sha256')
          .update([traceId, event.kind, event.seq, event.name].join(':'))
          .digest('hex')
          .slice(0, 32),
      } as TraceEvent);
    } else {
      events.push(line);
    }
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
        const priced = priceEvent(event);
        summary.llmCalls++;
        summary.totalInputTokens += event.inputTokens;
        summary.totalOutputTokens += event.outputTokens;
        summary.totalCachedTokens += event.cachedInputTokens ?? 0;
        summary.totalCostUsd += priced.usd;
        if (!priced.priced) summary.costComplete = false;
        const key = event.model;
        const existing = summary.byModel[key] ?? {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          priced: priced.priced,
        };
        existing.calls++;
        existing.inputTokens += event.inputTokens;
        existing.outputTokens += event.outputTokens;
        existing.costUsd = round(existing.costUsd + priced.usd, 6);
        existing.priced = existing.priced && priced.priced;
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

  // One alert when the trace crosses its budget. Firing per call would bury
  // the signal in noise, and the point is that someone should stop the run.
  if (costBudget > 0 && summary.totalCostUsd > costBudget && !anomalies.some((a) => a.kind === 'cost-spike')) {
    anomalies.push({
      kind: 'cost-spike',
      severity: 'critical',
      message: `Trace cost ${humanUsd(summary.totalCostUsd)} has crossed the ${humanUsd(costBudget)} budget`,
      ts: new Date().toISOString(),
      detail: { costUsd: summary.totalCostUsd, budget: costBudget, budgetBreached: true },
    });
  }
  summary.anomalies = [...anomalies];

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
 * Handles single and double quotes. It deliberately does not attempt to be a
 * shell: `shipready observe -- node app.js` should run `node app.js`, not hand a
 * string to `/bin/sh`. So backslash is NOT an escape character -- every agent
 * command anyone types on Windows contains a backslash path, and treating `\U`
 * as `U` silently produces "Cannot find module C:Users...".
 *
 * The complication is unquoted paths containing spaces. A Windows install
 * directory like `C:\Users\Jane Doe\bin\bash.exe` is two tokens under naive
 * splitting, and the first is spawned as a directory: the command does not run
 * and the real exit code is lost. So a token that is an existing file is never
 * split -- its trailing words are pulled back in. That resolves the common case
 * exactly, without trying to be a shell about the rest.
 */
export function parseCommand(input: string, cwd: string = process.cwd()): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
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
      if (started || current.length > 0) {
        // A file that exists wins over the whitespace: keep consuming until the
        // program name is a real file on disk, so a path with a space in it
        // survives. Stops at a non-existent first token, which is the ordinary
        // case (`node app.js`), so behaviour is unchanged for everything else.
        const joined = absorbExistingPath(input, i, current, cwd);
        if (joined !== null) {
          argv.push(joined.path);
          i = joined.nextIndex;
          current = '';
          started = false;
          continue;
        }
        argv.push(current);
      }
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

/**
 * Extend a candidate program token across whitespace while a longer existing
 * file can still be formed.
 *
 * Returns null when nothing longer resolves, which is the ordinary case and
 * means the caller should just push the bare token.
 *
 * The rule is "take the longest prefix that names a real file", not "stop at
 * the first one that does". A directory junction is a real file to `statSync`
 * and would otherwise end the search one word early, which is exactly the case
 * that broke here: `C:/Users/3tee` exists, so the naive check stopped and the
 * agent was spawned as a directory. Trying the next word and preferring the
 * longest hit resolves it without guessing.
 *
 * Bounded to a few segments. A program path is never longer, and an unbounded
 * search would swallow the whole command line.
 */
function absorbExistingPath(
  input: string,
  from: number,
  candidate: string,
  cwd: string,
): { path: string; nextIndex: number } | null {
  const MAX_SEGMENTS = 6;
  let path = candidate;
  let i = from;
  let best = isExistingFile(candidate, cwd) ? { path: candidate, nextIndex: from - 1 } : null;

  for (let extra = 0; extra < MAX_SEGMENTS; extra++) {
    // Skip the whitespace that separated the previous segment.
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;

    const start = i;
    while (i < input.length && !/\s/.test(input[i]!)) i++;
    const next = `${path} ${input.slice(start, i)}`;

    // Keep the last (longest) hit, so a directory junction earlier in the path
    // cannot win over the real executable further along.
    if (isExistingFile(next, cwd)) best = { path: next, nextIndex: i - 1 };
    path = next;
  }

  // Only rejoin when the token was genuinely broken, i.e. the bare first token
  // was not itself the program.
  return best && best.path !== candidate ? best : null;
}

/**
 * True when `p` names an existing file.
 *
 * Guards against a bare command name that happens to collide with a file, and
 * against the `.exe` suffix Windows needs but nobody types.
 *
 * Resolution is relative to the *child's* cwd, not ours. The agent is spawned
 * with `cwd` set, so `node app.js` in the command line refers to a file next to
 * the agent, and checking against our own directory would miss it and then
 * wrongly rejoin the next word into the program path.
 */
function isExistingFile(p: string, cwd: string): boolean {
  if (p === '' || p.includes('*') || p.includes('?')) return false;
  // Absolute paths are resolved by the OS as given. Relative ones have to be
  // joined to the child's directory or we look in the wrong place.
  const forms = isAbsolute(p) ? [p] : [resolve(cwd, p)];
  const candidates =
    process.platform === 'win32'
      ? forms.flatMap((f) => [f, `${f}.exe`, `${f}.cmd`, `${f}.bat`])
      : forms;
  return candidates.some((c) => {
    try {
      return statSync(c, { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      return false;
    }
  });
}

/** True for a path or bare name that Node would run directly. */
function isNodeScript(program: string): boolean {
  return /\\.(m|c)?js$/i.test(program) || /\\.ts$/i.test(program);
}

function isNodeProgram(program: string): boolean {
  const base = program.toLowerCase();
  // Only the runtime name. Returning true for a `.js` path here would make the
  // caller treat the script as the binary and pass it to `execPath` twice.
  return base === 'node' || base === 'nodejs' || base.endsWith('\\node.exe') || base.endsWith('/node');
}

/**
 * Price one model call.
 *
 * The preload is a sensor and deliberately carries no price catalogue, so
 * every cost is computed here. Events that arrive already priced (from the
 * programmatic `TraceRecorder`) are respected rather than recomputed.
 */
function priceEvent(event: Extract<TraceEvent, { kind: 'llm' }>): { usd: number; priced: boolean } {
  if (typeof event.costUsd === 'number' && typeof event.costPriced === 'boolean') {
    return { usd: event.costUsd, priced: event.costPriced };
  }
  return estimateCost(event.model, {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
  });
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
