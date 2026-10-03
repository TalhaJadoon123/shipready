import { renderTraceReport } from '@shipready/observer';
import { open as openBrowser } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { c, emit, error, heading, info, success, warn } from '../ui.js';
import { loadConfig } from '../config.js';
import { TraceStore, humanUsd } from '@shipready/observer';

/**
 * `shipready observe` and its subcommands.
 *
 * The wrapper (`observe -- <command>`) and the analysis commands (`report`,
 * `replay`, `compare`, `list`) live together because they share the trace
 * database and its resolution rules, and splitting them would mean two places
 * to answer "where is my data".
 */

export interface ObserveOptions {
  command: string;
  dbPath?: string;
  cwd?: string;
  costBudget?: number;
  costPerEvent?: number;
  captureContent?: boolean;
  quiet?: boolean;
  tui?: boolean;
  timeout?: number;
  json?: boolean;
}

export async function runObserve(options: ObserveOptions): Promise<number> {
  const { observe } = await import('@shipready/observer');
  const loaded = await loadConfig(options.cwd);
  for (const message of loaded.warnings) warn(message);

  const dbPath = options.dbPath ?? join(options.cwd ?? process.cwd(), '.shipready', 'traces.db');
  const costBudget = options.costBudget ?? loaded.config.observe.costBudget;
  const costPerTrace = options.costPerEvent ?? loaded.config.observe.costPerTrace;

  if (!options.quiet) {
    info(c.dim(`  Observing: ${options.command}`));
    if (costBudget > 0) info(c.dim(`  Cost budget: ${humanUsd(costBudget)}`));
  }

  const result = await observe({
    command: options.command,
    dbPath,
    cwd: options.cwd,
    ...(costBudget !== undefined ? { costBudget } : {}),
    ...(costPerTrace !== undefined ? { costPerEvent: costPerTrace } : {}),
    ...(options.captureContent !== undefined ? { captureContent: options.captureContent } : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  });

  if (!result.instrumented && result.reason && !options.quiet) {
    warn(`Not fully instrumented: ${result.reason}`);
  }

  if (options.json) {
    info(JSON.stringify(result.trace?.summary ?? { error: result.reason, exitCode: result.exitCode }, null, 2));
  }

  printSummary(result);

  return result.exitCode;
}

function printSummary(result: Awaited<ReturnType<typeof import('@shipready/observer').observe>>): void {
  if (!result.trace) return;
  const s = result.trace.summary;

  heading('  Trace');
  info(`  ${c.dim('cost')}      ${humanUsd(s.totalCostUsd)}${s.costComplete ? '' : c.yellow('  (incomplete: an unknown model was called)')}`);
  info(`  ${c.dim('tokens')}    ${s.totalInputTokens.toLocaleString()} in / ${s.totalOutputTokens.toLocaleString()} out`);
  info(`  ${c.dim('calls')}     ${s.llmCalls} model, ${s.toolCalls} tool, ${s.networkRequests} network, ${s.fileOps} file`);
  info(`  ${c.dim('duration')}  ${(s.durationMs / 1000).toFixed(1)}s, exit ${s.exitCode ?? 'n/a'}`);

  const tools = Object.entries(s.toolDistribution).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    info('');
    info(`  ${c.dim('tools')}`);
    for (const [tool, count] of tools.slice(0, 8)) {
      info(`    ${tool.padEnd(24)} ${count}`);
    }
  }

  const models = Object.entries(s.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (models.length > 0) {
    info('');
    info(`  ${c.dim('models')}`);
    for (const [model, m] of models) {
      const cost = m.priced ? humanUsd(m.costUsd) : 'cost unknown';
      info(`    ${model.padEnd(30)} ${String(m.calls).padStart(3)} calls  ${cost}`);
    }
  }

  if (s.anomalies.length > 0) {
    info('');
    info(`  ${c.bold('Anomalies')}`);
    for (const anomaly of s.anomalies.slice(0, 10)) {
      const colour = anomaly.severity === 'critical' ? c.red : anomaly.severity === 'warning' ? c.yellow : c.blue;
      info(`    ${colour(anomaly.severity.padEnd(8))} ${anomaly.message}`);
    }
  }

  info('');
  info(c.dim('  shipready observe report    HTML report with charts'));
  info(c.dim('  shipready observe replay    step through what the agent did'));
}

export interface TraceOptions {
  subcommand: 'report' | 'replay' | 'compare' | 'list' | 'cost';
  dbPath?: string;
  cwd?: string;
  traceId?: string;
  output?: string;
  format?: string;
  speed?: number;
  verbose?: boolean;
  open?: boolean;
  limit?: number;
  json?: boolean;
}

export async function runTraceCommand(options: TraceOptions): Promise<number> {
  const dbPath = options.dbPath ?? join(options.cwd ?? process.cwd(), '.shipready', 'traces.db');
  if (!existsSync(dbPath)) {
    error(`No traces found at ${dbPath}. Run \`shipready observe -- <command>\` first.`);
    return 2;
  }

  const store = new TraceStore(dbPath);
  try {
    switch (options.subcommand) {
      case 'list':
        return listTraces(store, options);
      case 'cost':
        return showCost(store, options);
      case 'report':
        return reportTrace(store, options);
      case 'replay':
        return replayTrace(store, options);
      case 'compare':
        return compareTraces(store, options);
      default:
        error(`Unknown observe subcommand "${options.subcommand}"`);
        return 2;
    }
  } finally {
    store.close();
  }
}

function listTraces(store: TraceStore, options: TraceOptions): number {
  const traces = store.listTraces(options.limit ?? 20);
  if (traces.length === 0) {
    info('No traces recorded yet.');
    return 0;
  }

  if (options.json) {
    info(JSON.stringify(traces, null, 2));
    return 0;
  }

  heading(`  Recent traces (${traces.length})`);
  info(
    `  ${c.dim('id'.padEnd(12))} ${c.dim('started'.padEnd(26))} ${c.dim('cost'.padStart(10))} ${c.dim('calls'.padStart(7))} ${c.dim('tools'.padStart(7))} ${c.dim('err'.padStart(5))}  command`,
  );
  for (const trace of traces) {
    const flagged = trace.anomalies.length > 0 ? c.yellow('!') : ' ';
    info(
      `  ${trace.id.slice(0, 10).padEnd(12)} ${trace.startedAt.replace('T', ' ').slice(0, 24).padEnd(26)} ${humanUsd(trace.totalCostUsd).padStart(10)} ${String(trace.llmCalls).padStart(7)} ${String(trace.toolCalls).padStart(7)} ${String(trace.errors).padStart(4)}${flagged}  ${trace.command.slice(0, 44)}`,
    );
  }
  info('');
  info(c.dim('  shipready observe report <id>    HTML report'));
  info(c.dim('  shipready observe replay <id>    replay the trace'));
  info('');
  return 0;
}

function showCost(store: TraceStore, options: TraceOptions): number {
  if (options.json) {
    info(JSON.stringify(store.costByDay(options.limit ?? 30), null, 2));
    return 0;
  }

  heading('  Cost by day');
  const days = store.costByDay(options.limit ?? 30);
  if (days.length === 0) {
    info('No cost recorded.');
    return 0;
  }
  const max = Math.max(...days.map((d) => d.costUsd), 0.0001);
  for (const day of days) {
    const filled = Math.max(1, Math.round((day.costUsd / max) * 24));
    info(`  ${day.day}  ${c.green('█'.repeat(filled))} ${humanUsd(day.costUsd).padStart(10)}  ${day.llmCalls} calls`);
  }
  const total = days.reduce((sum, d) => sum + d.costUsd, 0);
  info('');
  info(`  ${c.bold('Total')} ${humanUsd(total)} over ${days.length} day(s)`);
  info('');
  return 0;
}

async function reportTrace(store: TraceStore, options: TraceOptions): Promise<number> {
  const trace = resolveTrace(store, options.traceId);
  if (!trace) return 2;
  const html = renderTraceReport(trace, { title: `Agent trace ${trace.summary.id.slice(0, 8)}` });

  if (options.output) {
    await emit(html, options.output);
    return 0;
  }

  // A named HTML file rather than stdout: the report is a web page, and a web
  // page piped to a terminal is useless.
  const out = join(process.cwd(), '.shipready', `trace-${trace.summary.id.slice(0, 8)}.html`);
  await emit(html, out);
  success(`Report written. Open ${out}`);

  if (options.open) {
    try {
      await openBrowser(out);
    } catch {
      info(c.dim('  Could not open a browser automatically.'));
    }
  }
  return 0;
}

async function replayTrace(store: TraceStore, options: TraceOptions): Promise<number> {
  const trace = resolveTrace(store, options.traceId);
  if (!trace) return 2;
  const { replay } = await import('@shipready/observer');
  heading(`  Replaying ${trace.summary.id.slice(0, 8)} (${trace.events.length} events)`);
  info('');
  await replay({
    trace,
    speed: options.speed ?? 0,
    verbose: Boolean(options.verbose),
  });
  return 0;
}

async function compareTraces(store: TraceStore, options: TraceOptions): Promise<number> {
  const after = resolveTrace(store, options.traceId);
  if (!after) return 2;

  // Default to the run immediately before this one: that is the comparison
  // someone means by "compare these two".
  const previousSummary = store.previous(after.summary.id);
  if (!previousSummary) {
    error('No earlier trace to compare against. Run the agent a second time.');
    return 2;
  }
  const before = store.getTrace(previousSummary.id);
  if (!before) return 2;

  const { diffTraces } = await import('@shipready/observer');
  const diff = diffTraces(before, after);

  heading(`  ${diff.before.slice(0, 8)} -> ${diff.after.slice(0, 8)}`);
  info('');
  info(`  ${c.bold(diff.headline)}`);
  info('');

  for (const metric of diff.scorecard) {
    if (metric.delta === 0) continue;
    const arrow = metric.delta > 0 ? '+' : '';
    const colour = metric.worse ? c.red : c.green;
    const percent = metric.percent === null ? '' : c.dim(` (${metric.percent > 0 ? '+' : ''}${metric.percent.toFixed(0)}%)`);
    info(`  ${metric.metric.padEnd(22)} ${String(metric.before).padStart(10)} -> ${String(metric.after).padStart(10)}  ${colour(`${arrow}${metric.delta}`)}${percent}`);
  }

  if (diff.modelChanges.length > 0) {
    info('');
    info(`  ${c.bold('Models')}`);
    for (const change of diff.modelChanges.slice(0, 10)) {
      info(`    ${change.name.padEnd(30)} ${change.before} -> ${change.after}`);
    }
  }

  if (diff.toolChanges.length > 0) {
    info('');
    info(`  ${c.bold('Tools')}`);
    for (const change of diff.toolChanges.slice(0, 10)) {
      const marker = change.before === 0 ? c.green('  new') : change.after === 0 ? c.yellow('  gone') : '';
      info(`    ${change.name.padEnd(30)} ${change.before} -> ${change.after}${marker}`);
    }
  }

  if (diff.newHosts.length > 0) {
    info('');
    info(`  ${c.bold('New hosts')} ${diff.newHosts.join(', ')}`);
  }

  if (diff.advice.length > 0) {
    info('');
    info(`  ${c.bold('What this suggests')}`);
    for (const advice of diff.advice) info(`    - ${advice}`);
  }
  info('');
  return 0;
}

/** The most recent trace, or the one named by id. */
function resolveTrace(store: TraceStore, traceId?: string) {
  const id = traceId ?? store.latest()?.id;
  if (!id) {
    error('No traces recorded yet.');
    return null;
  }
  const trace = store.getTrace(id);
  if (!trace) error(`No trace with id "${id}".`);
  return trace;
}