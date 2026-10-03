/**
 * The trace model.
 *
 * Everything the observer records. Design constraints:
 *
 *  - **Serializable.** A trace has to round-trip through SQLite, JSON and the
 *    dashboard without losing meaning.
 *  - **Never contains raw secrets.** Prompts and responses are hashed, not
 *    stored, unless the user explicitly opts in. An observability tool that
 *    quietly copies every prompt into a database file is a liability.
 *  - **Stable ids.** So `replay` and `compare` can reference events across runs.
 */

export type EventKind = 'llm' | 'tool' | 'file' | 'network' | 'decision' | 'error' | 'session';

export interface TraceEventFields<K extends EventKind = EventKind> {
  seq: number;
  /** Narrowed to `K` so an event literal spreads into the right union member. */
  kind: K;
  ts: string;
  offsetMs: number;
  name: string;
  data: Record<string, unknown>;
}

export interface TraceEventBase extends TraceEventFields {
  /** Stable, content-derived within a trace. */
  id: string;
  /** Duration of the operation, where it completed. */
  durationMs?: number;
  /** Set when the operation failed. */
  error?: string;
}

export interface LlmEvent extends TraceEventBase {
  kind: 'llm';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** USD estimate. Zero with `costPriced: false` for an unknown model. */
  costUsd: number;
  costPriced: boolean;
  /** SHA-256 of the prompt, so identical prompts are recognisable. */
  promptHash: string;
  /** SHA-256 of the response. */
  responseHash: string;
  promptTokens?: number;
  responseTokens?: number;
  /** Streaming flag. Streaming costs money on abandoned requests. */
  streaming?: boolean;
  finishReason?: string;
  toolCalls?: number;
}

export interface ToolEvent extends TraceEventBase {
  kind: 'tool';
  tool: string;
  /** Serialized arguments, truncated. Never stored raw by default. */
  argumentsHash: string;
  argumentsPreview?: string;
  success: boolean;
  resultPreview?: string;
}

export interface FileEvent extends TraceEventBase {
  kind: 'file';
  path: string;
  operation: 'read' | 'write' | 'delete' | 'stat';
  bytes: number;
}

export interface NetworkEvent extends TraceEventBase {
  kind: 'network';
  method: string;
  /** Host only, never the full URL: URLs carry tokens in query strings. */
  host: string;
  path?: string;
  status?: number;
  requestBytes?: number;
  responseBytes?: number;
}

export interface DecisionEvent extends TraceEventBase {
  kind: 'decision';
  /** What the agent decided to do. */
  decision: string;
  reasoningHash: string;
  /** Confidence or preference scores, when the agent exposes them. */
  scores?: Record<string, number>;
}

export interface ErrorEvent extends TraceEventBase {
  kind: 'error';
  message: string;
  stack?: string;
  fatal: boolean;
}

export interface SessionEvent extends TraceEventBase {
  kind: 'session';
  phase: 'start' | 'end';
  command: string;
  exitCode?: number;
  pid?: number;
  cwd?: string;
}

export type TraceEvent =
  | LlmEvent
  | ToolEvent
  | FileEvent
  | NetworkEvent
  | DecisionEvent
  | ErrorEvent
  | SessionEvent;

export interface TraceSummary {
  /** Unique per run. */
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  command: string;
  cwd: string;
  exitCode?: number;

  totalCostUsd: number;
  /** True when at least one model was not in the price catalogue. */
  costComplete: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;

  llmCalls: number;
  toolCalls: number;
  fileOps: number;
  networkRequests: number;
  decisions: number;
  errors: number;
  /** toolName -> call count. */
  toolDistribution: Record<string, number>;
  /** model -> { calls, inputTokens, outputTokens, costUsd }. */
  byModel: Record<string, ModelSummary>;
  /** Distinct network hosts contacted. */
  hosts: string[];
  /** Anomalies detected during the run. */
  anomalies: Anomaly[];
}

export interface ModelSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

export type AnomalyKind =
  | 'cost-spike'
  | 'unusual-host'
  | 'privilege-escalation'
  | 'loop'
  | 'large-payload'
  | 'unpriced-model'
  | 'tool-error-rate';

export interface Anomaly {
  kind: AnomalyKind;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  ts: string;
  /** Event the anomaly relates to, when applicable. */
  eventId?: string;
  detail?: Record<string, unknown>;
}

export interface Trace {
  summary: TraceSummary;
  events: TraceEvent[];
  /** Schema version, for migrations. */
  version: 1;
}

export interface ObserverOptions {
  /** Where the SQLite database lives. */
  dbPath: string;
  /** Override the generated trace id. Used by tests. */
  traceId?: string;
  /** The command being observed. Recorded on the session event. */
  command?: string;
  /** Record prompt and response text. Off by default: it is user data. */
  captureContent?: boolean;
  /** Max characters of preview to keep per event. */
  previewLength?: number;
  /** Alert when a trace exceeds this. 0 disables. */
  costBudget?: number;
  /** Alert when a single event exceeds this. 0 disables. */
  costPerEvent?: number;
  /** Called for each anomaly as it is detected. */
  onAnomaly?: (anomaly: Anomaly) => void;
  /** Called for each event as it is recorded. */
  onEvent?: (event: TraceEvent) => void;
  /** Emit JSON lines to stderr. */
  jsonl?: boolean;
  /** Project directory, for path redaction. */
  cwd?: string;
}

export const DEFAULT_PREVIEW_LENGTH = 200;

/** Recursively redact secrets from a value before it is stored. */
const SECRET_KEY_RE =
  /(?:api[_-]?key|secret|token|password|passwd|authorization|auth|bearer|credential|private[_-]?key|session|cookie|access[_-]?key)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Truncate a preview, marking that it was cut. */
export function preview(value: string, max = DEFAULT_PREVIEW_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… (${value.length} chars)`;
}