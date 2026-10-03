import { TraceStore } from './store.js';
import { humanDuration, humanUsd, tokens } from './util.js';
import type { Trace, TraceEvent } from './types.js';
import { MODEL_PRICES } from './pricing.js';

/**
 * Behavioural diff between two traces.
 *
 * The use case is a prompt change: did the agent get cheaper, slower, or did it
 * start making tool calls it did not make before? Those three questions are what
 * someone evaluating a prompt actually needs answered.
 *
 * We deliberately compare *behaviour* rather than text. Prompts are hashed, so
 * we report "the prompt changed" and not what it said -- which is also the
 * honest answer, since two runs almost never share a prompt hash.
 */
/** One thing whose count changed between two traces. */
export interface CountDelta {
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface TraceDiff {
  before: string;
  after: string;
  scorecard: MetricDelta[];
  modelChanges: CountDelta[];
  toolChanges: CountDelta[];
  newHosts: string[];
  droppedHosts: string[];
  newAnomalies: string[];
  resolvedAnomalies: string[];
  /** Plain-English read of the change. */
  headline: string;
  /** Findings a reviewer should look at. */
  advice: string[];
}

export interface MetricDelta {
  metric: string;
  before: number;
  after: number;
  delta: number;
  /** Percent change, or null when the baseline was zero. */
  percent: number | null;
  /** True when a change here is a regression rather than an improvement. */
  worse: boolean;
}

export function diffTraces(before: Trace, after: Trace): TraceDiff {
  const scorecard: MetricDelta[] = [
    metric('Total cost (USD)', before.summary.totalCostUsd, after.summary.totalCostUsd, true, 0.15),
    metric('Duration', before.summary.durationMs, after.summary.durationMs, true, 0.2),
    metric('LLM calls', before.summary.llmCalls, after.summary.llmCalls, true, 0.25),
    metric('Tool calls', before.summary.toolCalls, after.summary.toolCalls, false, 0.25),
    metric('Input tokens', before.summary.totalInputTokens, after.summary.totalInputTokens, true, 0.25),
    metric('Output tokens', before.summary.totalOutputTokens, after.summary.totalOutputTokens, true, 0.25),
    metric('Errors', before.summary.errors, after.summary.errors, true, 0.5),
    metric('Network requests', before.summary.networkRequests, after.summary.networkRequests, false, 0.3),
  ];

  const modelChanges = deltaCounts(before.summary.byModel, after.summary.byModel, (m) => m.calls);
  const toolChanges = deltaCounts(before.summary.toolDistribution, after.summary.toolDistribution, (n) => n);

  const beforeHosts = new Set(before.summary.hosts);
  const afterHosts = new Set(after.summary.hosts);
  const newHosts = [...afterHosts].filter((h) => !beforeHosts.has(h));
  const droppedHosts = [...beforeHosts].filter((h) => !afterHosts.has(h));

  const beforeAnomalies = new Set(before.summary.anomalies.map(anomalyKey));
  const afterAnomalies = new Set(after.summary.anomalies.map(anomalyKey));
  const newAnomalies = after.summary.anomalies.filter((a) => !beforeAnomalies.has(anomalyKey(a))).map((a) => a.message);
  const resolvedAnomalies = before.summary.anomalies
    .filter((a) => !afterAnomalies.has(anomalyKey(a)))
    .map((a) => a.message);

  const costDelta = after.summary.totalCostUsd - before.summary.totalCostUsd;
  const errorDelta = after.summary.errors - before.summary.errors;
  const toolDelta = after.summary.toolCalls - before.summary.toolCalls;
  const promptChanged = before.events.some(
    (e) => e.kind === 'llm' && !after.events.some((f) => f.kind === 'llm' && f.promptHash === e.promptHash),
  );

  const parts: string[] = [];
  if (costDelta > 0.005) parts.push(`cost rose ${humanUsd(costDelta)}`);
  else if (costDelta < -0.005) parts.push(`cost fell ${humanUsd(Math.abs(costDelta))}`);
  if (errorDelta > 0) parts.push(`${errorDelta} more error${errorDelta === 1 ? '' : 's'}`);
  if (toolDelta > 0) parts.push(`${toolDelta} more tool call${toolDelta === 1 ? '' : 's'}`);
  if (newHosts.length > 0) parts.push(`contacted ${newHosts.length} new host${newHosts.length === 1 ? '' : 's'}`);

  const headline = parts.length > 0 ? parts.join(', ') : 'No behavioural change worth reporting';

  const advice: string[] = [];
  if (promptChanged) advice.push('The prompt changed: at least one prompt hash differs between runs.');
  const costMetric = scorecard.find((m) => m.metric === 'Total cost (USD)')!;
  if (costMetric.worse && Math.abs(costMetric.percent ?? 0) > 20) {
    advice.push(`Cost rose ${Math.round(costMetric.percent ?? 0)}%. Check whether a more expensive model was selected, or whether the prompt got longer.`);
  }
  const outputMetric = scorecard.find((m) => m.metric === 'Output tokens')!;
  if (outputMetric.worse && (outputMetric.percent ?? 0) > 30) {
    advice.push(`Output tokens rose ${Math.round(outputMetric.percent ?? 0)}%. The model is likely generating more than you need; ask for a shorter answer or set a lower max_tokens.`);
  }
  if (toolDelta > 0) advice.push(`${toolDelta} more tool calls. Check whether the agent is now taking a longer path to the same answer.`);
  if (toolDelta < -3) advice.push(`${Math.abs(toolDelta)} fewer tool calls. If that was not intentional, the agent may be answering from the prompt alone.`);
  if (errorDelta > 0) advice.push(`${errorDelta} more errors. This usually means the new instructions pushed the agent somewhere it fails.`);
  if (newHosts.length > 0) advice.push(`New hosts: ${newHosts.join(', ')}. Confirm each one is expected.`);
  if (newAnomalies.length > 0) advice.push(`New anomalies: ${newAnomalies.length}.`);

  return {
    before: before.summary.id,
    after: after.summary.id,
    scorecard,
    modelChanges,
    toolChanges,
    newHosts,
    droppedHosts,
    newAnomalies,
    resolvedAnomalies,
    headline,
    advice,
  };
}

function metric(name: string, before: number, after: number, higherIsWorse: boolean, tolerance: number): MetricDelta {
  const delta = after - before;
  const percent = before === 0 ? null : (delta / Math.abs(before)) * 100;
  const worse = higherIsWorse ? delta > tolerance : delta < -tolerance;
  return { metric: name, before, after, delta, percent, worse };
}

/**
 * Counts for keys present in either trace, sorted by the size of the change.
 * A key absent from one side counts as zero rather than being skipped: a tool
 * that disappeared is the most interesting change in the list.
 */
function deltaCounts<T>(
  before: Record<string, T>,
  after: Record<string, T>,
  value: (entry: T) => number,
): CountDelta[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: CountDelta[] = [];
  for (const key of keys) {
    const entry = before[key];
    const b = entry !== undefined ? value(entry) : 0;
    const other = after[key];
    const a = other !== undefined ? value(other) : 0;
    if (b === a) continue;
    out.push({ name: key, before: b, after: a, delta: a - b });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

function anomalyKey(a: { kind: string; message: string }): string {
  return `${a.kind}:${a.message}`;
}

/**
 * Replay a trace, printing the agent's behaviour in order.
 *
 * `--speed` paces it to the original timing so you can watch the agent think;
 * at the default speed it is a fast read of what happened.
 */
export interface ReplayOptions {
  trace: Trace;
  speed?: number;
  /** Print full detail per event rather than one line. */
  verbose?: boolean;
  onEvent?: (event: TraceEvent, index: number) => void;
}

export async function replay(options: ReplayOptions): Promise<void> {
  const { trace, speed = 0, verbose = false, onEvent } = options;
  const events = [...trace.events].sort((a, b) => a.seq - b.seq);
  const start = Date.now();

  for (const [index, event] of events.entries()) {
    if (speed > 0) {
      const target = event.offsetMs / speed;
      const wait = target - (Date.now() - start);
      if (wait > 0) await sleep(wait);
    }
    onEvent?.(event, index);
    if (verbose) {
      process.stdout.write(`\n[+${(event.offsetMs / 1000).toFixed(2)}s] ${event.kind} ${event.name}\n${JSON.stringify(event.data, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReplayLine(event)}\n`);
    }
  }
}

function formatReplayLine(event: TraceEvent): string {
  const at = `+${(event.offsetMs / 1000).toFixed(2)}s`;
  switch (event.kind) {
    case 'llm': {
      // An unpriced model shows "cost?" rather than $0.00: a wrong number here
      // is worse than an honest blank.
      const cost = event.costPriced ? humanUsd(event.costUsd) : 'cost?';
      return `${at}  llm     ${event.model.padEnd(28)} ${tokens(event.inputTokens).padStart(6)} in ${tokens(event.outputTokens).padStart(6)} out  ${cost.padStart(8)}  ${event.durationMs ?? 0}ms`;
    }
    case 'tool':
      return `${at}  tool    ${event.tool.padEnd(28)} ${event.success ? 'ok  ' : 'FAIL'} ${event.durationMs ?? 0}ms  ${event.argumentsHash.slice(0, 8)}`;
    case 'file':
      return `${at}  file    ${event.operation.padEnd(28)} ${event.path.slice(0, 60)}`;
    case 'network':
      return `${at}  network ${`${event.method} ${event.host}`.padEnd(28)} ${event.status ?? '-'}  ${event.durationMs ?? 0}ms`;
    case 'decision':
      return `${at}  decide  ${event.decision.slice(0, 80)}`;
    case 'error':
      return `${at}  ERROR   ${event.message.slice(0, 100)}`;
    case 'session':
      return `${at}  session ${event.phase} ${event.command ?? ''}`;
    default: {
      // Exhaustive: every kind is handled above. This branch exists only so a new
      // event kind fails to compile rather than rendering `undefined`.
      const exhaustive: never = event;
      return `${at}  ${String((exhaustive as { kind?: string }).kind)}`;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open for a replay.
    timer.unref?.();
  });
}

export { TraceStore, humanDuration, MODEL_PRICES };