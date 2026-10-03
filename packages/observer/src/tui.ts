import { TraceRecorder } from './recorder.js';
import { TraceStore } from './store.js';
import { htmlEscape, humanDuration, humanUsd, tokens } from './util.js';
import type { TraceEvent } from './types.js';

/**
 * Terminal UI for a running trace.
 *
 * Implemented directly against ANSI escapes rather than with a TUI framework.
 * Ink would add React to the observer's dependency tree and, more importantly,
 * a renderer that fights the agent for stdout -- the agent's own output has to
 * stay readable, because watching the agent work is the point.
 *
 * Layout: a fixed status block above the agent's output, redrawn in place. The
 * block shows cost against budget, token counts, a live tool stream, and any
 * anomalies. If the terminal is not a TTY, everything degrades to plain lines.
 */

export interface TuiOptions {
  recorder: TraceRecorder;
  /** Total width of the status block. */
  width?: number;
  /** Show the live tool call stream. */
  stream?: boolean;
}

export class TraceTui {
  private readonly recorder: TraceRecorder;
  private readonly width: number;
  private readonly showStream: boolean;
  private readonly isTty: boolean;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private lastAnomalyCount = 0;

  constructor(options: TuiOptions) {
    this.recorder = options.recorder;
    this.width = options.width ?? Math.min(process.stdout.columns ?? 100, 110);
    this.showStream = options.stream ?? true;
    this.isTty = process.stdout.isTTY === true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.render();

    // Redraw at 4 Hz: fast enough to feel live, slow enough to be readable.
    this.timer = setInterval(() => this.render(), 250);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.isTty) {
      // Clear the block we drew so the agent's final output is not buried.
      process.stdout.write('\x1b[1A\x1b[2K'.repeat(1));
    }
  }

  render(): void {
    const snapshot = this.recorder.snapshot();
    const lines = [
      ...this.headerLines(snapshot),
      ...(this.showStream ? this.streamLines(snapshot.recent) : []),
    ];

    if (!this.isTty) {
      // Non-TTY: emit a single status line occasionally rather than a block.
      process.stderr.write(
        `[shipready] ${humanUsd(snapshot.costUsd)} · ${tokens(snapshot.inputTokens)} in / ${tokens(snapshot.outputTokens)} out · ${snapshot.llmCalls} llm · ${snapshot.toolCalls} tools · ${humanDuration(snapshot.elapsedMs)}\n`,
      );
      return;
    }

    // Move up over the previous block, then rewrite it. Using save/restore keeps
    // the agent's own output intact above us.
    process.stdout.write(lines.map((line) => `\x1b[2K${line}\n`).join(''));
    process.stdout.write(`\x1b[${lines.length}A`);
  }

  private headerLines(snapshot: ReturnType<TraceRecorder['snapshot']>): string[] {
    const budget = this.recorder['options']?.costBudget ?? 0;
    const costCell =
      budget > 0
        ? `${humanUsd(snapshot.costUsd)} / ${humanUsd(budget)}${this.bar(snapshot.costUsd / budget)}`
        : humanUsd(snapshot.costUsd);

    const lines = [
      this.frame([
        `cost ${costCell}`,
        `${tokens(snapshot.inputTokens)} in`,
        `${tokens(snapshot.outputTokens)} out`,
        `${snapshot.llmCalls} llm`,
        `${snapshot.toolCalls} tools`,
        snapshot.errors > 0 ? `${snapshot.errors} err` : '',
        humanDuration(snapshot.elapsedMs),
      ].filter(Boolean)),
    ];

    if (!snapshot.costComplete) {
      lines.push(this.frame(['! cost incomplete: an unknown model was called'], 'warn'));
    }

    for (const anomaly of snapshot.anomalies.slice(-3)) {
      if (snapshot.anomalies.indexOf(anomaly) < this.lastAnomalyCount) continue;
      lines.push(this.frame([`${anomaly.severity.toUpperCase()} ${anomaly.message}`], anomaly.severity === 'critical' ? 'bad' : 'warn'));
    }
    this.lastAnomalyCount = snapshot.anomalies.length;

    return lines;
  }

  private streamLines(recent: readonly TraceEvent[]): string[] {
    const recent3 = recent.slice(-3);
    const rendered = recent3.map((event) => {
      const at = `+${(event.offsetMs / 1000).toFixed(1)}s`;
      switch (event.kind) {
        case 'llm':
          return `${at} llm ${event.model} ${tokens(event.inputTokens)}→${tokens(event.outputTokens)}${event.costPriced ? ` ${humanUsd(event.costUsd)}` : ''}`;
        case 'tool':
          return `${at} tool ${event.tool} ${event.success ? 'ok' : 'FAILED'}`;
        case 'network':
          return `${at} net ${event.method} ${event.host}${event.status ? ` ${event.status}` : ''}`;
        case 'file':
          return `${at} file ${event.operation} ${basename(event.path)}`;
        case 'decision':
          return `${at} decide ${event.decision.slice(0, 40)}`;
        case 'error':
          return `${at} ERROR ${event.message.slice(0, 60)}`;
        default:
          return '';
      }
    });
    if (rendered.length === 0) return [];
    return rendered.map((line) => this.frame([line], 'dim'));
  }

  private frame(cells: string[], tone: 'dim' | 'warn' | 'bad' = 'dim'): string {
    const body = ` ${cells.join('  ')} `;
    const dash = '─'.repeat(Math.max(0, this.width - 2));
    const colour = tone === 'bad' ? '\x1b[31m' : tone === 'warn' ? '\x1b[33m' : '\x1b[90m';
    return `${colour}┌${dash}┐\x1b[0m\n${colour}│\x1b[0m${truncateCells(body, this.width - 2)}\n${colour}└${dash}┘\x1b[0m`;
  }

  private bar(fraction: number, size = 10): string {
    const filled = Math.max(0, Math.min(size, Math.round(fraction * size)));
    const colour = fraction > 1 ? '\x1b[31m' : fraction > 0.8 ? '\x1b[33m' : '\x1b[32m';
    return ` ${colour}${'█'.repeat(filled)}\x1b[90m${'░'.repeat(size - filled)}\x1b[0m`;
  }
}

/**
 * A one-line-per-event trace view for logs and non-interactive terminals.
 * Same information as the TUI, no cursor control.
 */
export function formatTraceLines(trace: { summary: unknown; events: readonly TraceEvent[] }, verbose = false): string {
  const lines: string[] = [];
  for (const event of [...trace.events].sort((a, b) => a.seq - b.seq)) {
    const at = `+${(event.offsetMs / 1000).toFixed(2)}s`;
    lines.push(`${at} ${event.kind.padEnd(8)} ${event.name}${verbose ? ` ${JSON.stringify(event.data)}` : ''}`);
  }
  return lines.join('\n');
}

export { TraceStore, htmlEscape, humanDuration, humanUsd, tokens };

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function truncateCells(body: string, max: number): string {
  // Cheap truncation. Good enough for a status line, and it never splits an
  // escape sequence that matters because we cut at a character boundary.
  return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
}