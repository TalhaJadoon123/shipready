import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_PREVIEW_LENGTH,
  preview,
  redactSecrets,
  type Anomaly,
  type AnomalyKind,
  type DecisionEvent,
  type ErrorEvent,
  type FileEvent,
  type LlmEvent,
  type ModelSummary,
  type NetworkEvent,
  type ObserverOptions,
  type ToolEvent,
  type Trace,
  type TraceEvent,
  type TraceEventFields,
  type TraceSummary,
} from './types.js';
import { estimateCost, lookupModel } from './pricing.js';

/**
 * In-memory trace accumulation.
 *
 * SQLite is the durable store; this is the hot path. Events arrive one at a
 * time from instrumentation running inside someone else's process, so nothing
 * here does I/O -- that keeps the observer from ever being the reason a tool
 * feels slow, which is the only way an observability tool gets uninstalled.
 */
export class TraceRecorder {
  readonly id: string;
  readonly startedAt: Date;
  readonly command: string;
  readonly cwd: string;

  private readonly events: TraceEvent[] = [];
  private readonly options: ObserverOptions;
  private readonly seq = { n: 0 };
  private readonly anomalies: Anomaly[] = [];
  private readonly hostFirstSeen = new Map<string, number>();
  private readonly toolCounts = new Map<string, number>();
  private readonly byModel = new Map<string, ModelSummary>();
  private runningCostUsd = 0;
  private costComplete = true;
  private ended = false;
  private exitCode: number | undefined;
  private bytesOut = 0;
  private bytesIn = 0;

  constructor(command: string, options: ObserverOptions, cwd = process.cwd()) {
    this.id = options.traceId ?? randomUUID();
    this.startedAt = new Date();
    this.command = command;
    this.cwd = cwd;
    this.options = options;
    this.previewLength = options.previewLength ?? DEFAULT_PREVIEW_LENGTH;

    // The opening session event goes through `base()` so it carries the same
    // fields as every other event; the sequence number has to be assigned by
    // the recorder, not by the caller.
    this.finish({
      ...this.base('session', 'start'),
      phase: 'start',
      command,
      pid: process.pid,
      cwd,
    });
  }

  private readonly previewLength: number;

  private now(): number {
    return Date.now();
  }

  /**
   * Common fields for every event: sequence, timestamps and data bag.
   *
   * Generic over the kind so the result narrows to the right member of the
   * discriminated union when spread into a concrete event literal.
   */
  private base<K extends TraceEvent['kind']>(kind: K, name: string): TraceEventFields<K> {
    return {
      seq: this.seq.n++,
      kind,
      ts: new Date(this.now()).toISOString(),
      offsetMs: this.now() - this.startedAt.getTime(),
      name,
      data: {},
    };
  }

  private finish<T extends TraceEventFields>(event: T): T & { id: string } {
    // Ids are assigned here rather than at each call site: an event without one
    // cannot be inserted into SQLite, and the constraint failure is obscure.
    const id = TraceRecorder.hash([this.id, event.kind, event.seq, event.name, JSON.stringify(event.data)].join(":"));
    const complete = { ...event, id } as T & { id: string };
    this.events.push(complete as unknown as TraceEvent);
    // Budget checks run on every event, not only timed ones: a streaming call
    // with no reported duration still costs money.
    this.checkBudget(complete as unknown as TraceEvent);
    this.options.onEvent?.(complete as unknown as TraceEvent);
    return complete;
  }


  /** Hash helper, used for every prompt/response/argument digest. */
  static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
  }

  // -------------------------------------------------------------------------
  // Event recorders
  // -------------------------------------------------------------------------

  llm(input: {
    provider: string;
    model: string;
    /** Raw prompt text. Hashed, and only stored when captureContent is on. */
    prompt?: string;
    /** Raw response text. Same treatment. */
    response?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    durationMs?: number;
    streaming?: boolean;
    finishReason?: string;
    toolCalls?: number;
    error?: string;
  }): LlmEvent {
    const estimate = estimateCost(input.model, {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
    });

    this.runningCostUsd += estimate.usd;
    if (!estimate.priced) this.costComplete = false;

    const known = lookupModel(input.model);
    const event = {
      ...this.base('llm', input.model),
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
      costUsd: estimate.usd,
      costPriced: estimate.priced,
      promptHash: TraceRecorder.hash(input.prompt ?? ''),
      responseHash: TraceRecorder.hash(input.response ?? ''),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.streaming !== undefined ? { streaming: input.streaming } : {}),
      ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      data: {
        ...(known ? { contextWindow: known.contextWindow, pricedAs: known.id } : {}),
        ...(this.options.captureContent && input.prompt
          ? { prompt: preview(input.prompt, this.previewLength) }
          : {}),
        ...(this.options.captureContent && input.response
          ? { response: preview(input.response, this.previewLength) }
          : {}),
      },
    };

    this.accumulateModel(input.model, input.inputTokens, input.outputTokens, estimate.usd, estimate.priced);

    if (!estimate.priced) {
      this.anomaly({
        kind: 'unpriced-model',
        severity: 'warning',
        message: `Unknown model "${input.model}": token counts recorded, cost not estimated`,
        ts: event.ts,
        detail: { model: input.model },
      });
    }
    if (this.options.costPerEvent && estimate.usd > this.options.costPerEvent) {
      this.anomaly({
        kind: 'cost-spike',
        severity: 'warning',
        message: `Single call cost $${estimate.usd.toFixed(4)} on ${input.model}`,
        ts: event.ts,
        detail: { costUsd: estimate.usd, model: input.model, budget: this.options.costPerEvent },
      });
    }
    return this.finish(event);
  }

  tool(input: {
    tool: string;
    args?: unknown;
    result?: unknown;
    success: boolean;
    durationMs?: number;
    error?: string;
  }): ToolEvent {
    this.toolCounts.set(input.tool, (this.toolCounts.get(input.tool) ?? 0) + 1);
    const serialized = safeStringify(input.args);

    const event = {
      ...this.base('tool', input.tool),
      tool: input.tool,
      argumentsHash: TraceRecorder.hash(serialized),
      success: input.success,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      data: {
        ...(this.options.captureContent
          ? {
              argumentsPreview: preview(serialized, this.previewLength),
              ...(input.result !== undefined
                ? { resultPreview: preview(safeStringify(input.result), this.previewLength) }
                : {}),
            }
          : {}),
        argumentKeys: input.args && typeof input.args === 'object' ? Object.keys(input.args as object).slice(0, 20) : [],
      },
    };
    return this.finish(event);
  }

  file(input: { path: string; operation: FileEvent['operation']; bytes?: number }): FileEvent {
    const event = {
      ...this.base('file', input.path),
      path: input.path,
      operation: input.operation,
      bytes: input.bytes ?? 0,
      data: {},
    };
    if (input.bytes && input.bytes > 5_000_000) {
      this.anomaly({
        kind: 'large-payload',
        severity: 'info',
        message: `${(input.bytes / 1_000_000).toFixed(1)} MB ${input.operation} on ${input.path}`,
        ts: event.ts,
        detail: { bytes: input.bytes, path: input.path },
      });
    }
    return this.finish(event);
  }

  network(input: {
    method: string;
    /** Full URL or host. Only the host is stored. */
    url: string;
    status?: number;
    requestBytes?: number;
    responseBytes?: number;
    durationMs?: number;
    error?: string;
  }): NetworkEvent {
    const host = hostOf(input.url);
    this.bytesOut += input.requestBytes ?? 0;
    this.bytesIn += input.responseBytes ?? 0;

    const seenAt = this.hostFirstSeen.get(host);
    if (seenAt === undefined) {
      this.hostFirstSeen.set(host, this.events.length);
      // A connection the agent has not made before is worth surfacing once.
      if (this.hostFirstSeen.size > 1 && isInterestingHost(host)) {
        this.anomaly({
          kind: 'unusual-host',
          severity: 'info',
          message: `First contact with ${host}`,
          ts: new Date(this.now()).toISOString(),
          detail: { host },
        });
      }
    }

    const event = {
      ...this.base('network', `${input.method} ${host}`),
      method: input.method,
      host,
      status: input.status,
      ...(input.requestBytes !== undefined ? { requestBytes: input.requestBytes } : {}),
      ...(input.responseBytes !== undefined ? { responseBytes: input.responseBytes } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      data: { firstContact: seenAt === undefined },
    };
    return this.finish(event);
  }

  decision(input: { decision: string; reasoning?: string; scores?: Record<string, number>; durationMs?: number }): DecisionEvent {
    const event = {
      ...this.base('decision', input.decision),
      decision: input.decision,
      reasoningHash: TraceRecorder.hash(input.reasoning ?? ''),
      ...(input.scores ? { scores: input.scores } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      data: this.options.captureContent && input.reasoning
        ? { reasoning: preview(input.reasoning, this.previewLength) }
        : {},
    };
    return this.finish(event);
  }

  error(input: { message: string; stack?: string; fatal?: boolean }): ErrorEvent {
    const event = {
      ...this.base('error', input.message.slice(0, 80)),
      message: input.message,
      stack: input.stack,
      fatal: input.fatal ?? false,
      data: {},
    };
    return this.finish(event);
  }

  // -------------------------------------------------------------------------
  // Anomalies
  // -------------------------------------------------------------------------

  /** Fire once when the cumulative cost crosses the configured budget. */
  private checkBudget(event: TraceEvent): void {
    if (!this.options.costBudget) return;
    if (event.kind !== 'llm') return;
    if (this.runningCostUsd <= this.options.costBudget) return;
    // Fire once per crossing rather than on every subsequent call.
    const already = this.anomalies.some((a) => a.kind === 'cost-spike' && a.detail?.budgetBreached === true);
    if (already) return;
    this.anomaly({
      kind: 'cost-spike',
      severity: 'critical',
      message: `Trace cost $${this.runningCostUsd.toFixed(2)} has crossed the $${this.options.costBudget.toFixed(2)} budget`,
      ts: event.ts,
      detail: { costUsd: this.runningCostUsd, budget: this.options.costBudget, budgetBreached: true },
    });
  }

  private anomaly(input: Omit<Anomaly, 'ts'> & { ts?: string }): void {
    const anomaly: Anomaly = { ...input, ts: input.ts ?? new Date(this.now()).toISOString() };
    this.anomalies.push(anomaly);
    this.options.onAnomaly?.(anomaly);
    if (this.options.jsonl) {
      process.stderr.write(`${JSON.stringify({ type: 'anomaly', ...anomaly })}\n`);
    }
  }

  /** Record an anomaly detected by a caller, for example by the runtime shim. */
  flag(anomaly: Omit<Anomaly, 'ts'>): Anomaly {
    const withTs: Anomaly = { ...anomaly, ts: new Date(this.now()).toISOString() };
    this.anomalies.push(withTs);
    this.options.onAnomaly?.(withTs);
    return withTs;
  }

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  private accumulateModel(model: string, input: number, output: number, cost: number, priced: boolean): void {
    const entry = this.byModel.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, priced };
    entry.calls++;
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.costUsd = round(entry.costUsd + cost, 6);
    entry.priced = entry.priced && priced;
    this.byModel.set(model, entry);
  }

  /** The cost so far, for live TUI display. */
  get currentCostUsd(): number {
    return round(this.runningCostUsd, 6);
  }

  get eventCount(): number {
    return this.events.length;
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt.getTime();
  }

  /** Close the trace. Idempotent, so a double-SIGTERM cannot corrupt it. */
  end(exitCode?: number): Trace {
    if (this.ended) return this.toTrace();
    this.ended = true;
    this.exitCode = exitCode;
    this.finish({
      ...this.base('session', 'end'),
      phase: 'end',
      command: this.command,
      ...(exitCode !== undefined ? { exitCode } : {}),
      data: { bytesOut: this.bytesOut, bytesIn: this.bytesIn },
    });
    return this.toTrace();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  toTrace(): Trace {
    const summary = this.summary();
    return { summary, events: [...this.events], version: 1 };
  }

  summary(): TraceSummary {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let fileOps = 0;
    let networkRequests = 0;
    let decisions = 0;
    let errors = 0;

    for (const event of this.events) {
      switch (event.kind) {
        case 'llm':
          llmCalls++;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          cachedTokens += event.cachedInputTokens ?? 0;
          break;
        case 'tool':
          toolCalls++;
          break;
        case 'file':
          fileOps++;
          break;
        case 'network':
          networkRequests++;
          break;
        case 'decision':
          decisions++;
          break;
        case 'error':
          errors++;
          break;
        default:
          break;
      }
    }

    const toolDistribution: Record<string, number> = {};
    for (const [tool, count] of this.toolCounts) toolDistribution[tool] = count;
    const byModel: Record<string, ModelSummary> = {};
    for (const [model, summary] of this.byModel) byModel[model] = summary;

    return {
      id: this.id,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.ended ? new Date(this.now()).toISOString() : undefined,
      durationMs: this.elapsedMs,
      command: this.command,
      cwd: this.cwd,
      exitCode: this.exitCode,
      totalCostUsd: this.currentCostUsd,
      costComplete: this.costComplete,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalCachedTokens: cachedTokens,
      llmCalls,
      toolCalls,
      fileOps,
      networkRequests,
      decisions,
      errors,
      toolDistribution,
      byModel,
      hosts: [...this.hostFirstSeen.keys()],
      anomalies: [...this.anomalies],
    };
  }

  /** Snapshot for the live TUI, cheap enough to call on every frame. */
  snapshot(): {
    costUsd: number;
    costComplete: boolean;
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
    errors: number;
    elapsedMs: number;
    recent: TraceEvent[];
    anomalies: Anomaly[];
  } {
    const summary = this.summary();
    return {
      costUsd: summary.totalCostUsd,
      costComplete: summary.costComplete,
      inputTokens: summary.totalInputTokens,
      outputTokens: summary.totalOutputTokens,
      llmCalls: summary.llmCalls,
      toolCalls: summary.toolCalls,
      errors: summary.errors,
      elapsedMs: summary.durationMs,
      recent: this.events.slice(-12),
      anomalies: summary.anomalies.slice(-4),
    };
  }
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(redactSecrets(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Not a URL: treat the first path-ish token as the host.
    return url.replace(/^\/\//, '').split(/[/?#]/)[0] ?? url;
  }
}

/**
 * Hosts worth mentioning on first contact.
 *
 * Model providers and package registries are expected. Anything else -- an
 * IP address, a paste site, an unfamiliar TLD -- is worth a human glance,
 * because that is what data exfiltration looks like.
 */
function isInterestingHost(host: string): boolean {
  const known =
    /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|google\.com|azure\.com|mistral\.ai|cohere\.com|groq\.com|localhost|127\.0\.0\.1)$/i;
  if (known.test(host)) return false;
  if (/^(registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|github\.com|raw\.githubusercontent\.com|crates\.io|proxy\.golang\.org)$/i.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/\.(tk|ml|ga|cf|gq|pastebin\.com|ngrok\.io|requestbin|webhook\.site)$/i.test(host)) return true;
  return true;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export type { AnomalyKind };
