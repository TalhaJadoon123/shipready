/**
 * `@shipready/observer` -- lightweight agent observability.
 *
 * The design goal is one command and no configuration. Most observability tools
 * want an agent, a collector and a dashboard before they will tell you anything.
 * This one watches the three boundaries every agent crosses -- network,
 * filesystem, process execution -- and gives you cost, tokens and a trace in a
 * local SQLite file.
 */

// --- Core model -------------------------------------------------------------
export type {
  Anomaly,
  AnomalyKind,
  DecisionEvent,
  ErrorEvent,
  EventKind,
  FileEvent,
  LlmEvent,
  ModelSummary,
  NetworkEvent,
  ObserverOptions,
  SessionEvent,
  ToolEvent,
  Trace,
  TraceEvent,
  TraceEventBase,
  TraceSummary,
} from './types.js';
export { DEFAULT_PREVIEW_LENGTH, preview, redactSecrets } from './types.js';

// --- Recording --------------------------------------------------------------
export { TraceRecorder } from './recorder.js';

// --- Storage ----------------------------------------------------------------
export { TraceStore } from './store.js';

// --- Pricing ----------------------------------------------------------------
export {
  MODEL_PRICES,
  estimateCost,
  estimateTextCost,
  estimateTokens,
  lookupModel,
  type CostEstimate,
  type ModelPrice,
  type Provider,
  type Usage,
} from './pricing.js';

// --- Running an agent -------------------------------------------------------
export {
  createRecorder,
  observe,
  parseCommand,
  type ObserveOptions,
  type ObserveResult,
} from './observe.js';

// --- Instrumentation --------------------------------------------------------
export { installRuntimeHooks, wrap, type InstrumentedAgent } from './runtime.js';

// --- Analysis ---------------------------------------------------------------
export { diffTraces, replay, type MetricDelta, type ReplayOptions, type TraceDiff } from './diff.js';

// --- Rendering --------------------------------------------------------------
export { renderTraceReport } from './html.js';
export { TraceTui, formatTraceLines, type TuiOptions } from './tui.js';
export { htmlEscape, humanBytes, humanDuration, humanUsd, tokens } from './util.js';