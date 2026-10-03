import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Anomaly, Trace, TraceEvent, TraceSummary } from './types.js';

/**
 * SQLite-backed trace store.
 *
 * `better-sqlite3` is synchronous by design, which is the right trade here: the
 * observer writes from inside someone else's process and must never block it.
 * Batched through a prepared statement, a trace of a few thousand events lands
 * in a few milliseconds.
 *
 * Deleting a database is the user's decision, not ours: traces contain hashes of
 * their prompts and hosts they contacted. Retention is documented rather than
 * enforced, except that we never write prompt or response text unless the user
 * explicitly asked for it.
 */
export class TraceStore {
  private readonly db: BetterSqlite3.Database;
  private readonly insertEvent: BetterSqlite3.Statement;
  private readonly insertAnomaly: BetterSqlite3.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new BetterSqlite3(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();

    this.insertEvent = this.db.prepare(`
      INSERT OR REPLACE INTO events (id, trace_id, seq, kind, ts, offset_ms, name, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertAnomaly = this.db.prepare(`
      INSERT OR REPLACE INTO anomalies (trace_id, ts, kind, severity, message, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id            TEXT PRIMARY KEY,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        command       TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        exit_code     INTEGER,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        cost_complete INTEGER NOT NULL DEFAULT 1,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        llm_calls     INTEGER NOT NULL DEFAULT 0,
        tool_calls    INTEGER NOT NULL DEFAULT 0,
        file_ops      INTEGER NOT NULL DEFAULT 0,
        network_calls INTEGER NOT NULL DEFAULT 0,
        errors        INTEGER NOT NULL DEFAULT 0,
        summary_json  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id         TEXT NOT NULL,
        trace_id   TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        ts         TEXT NOT NULL,
        offset_ms  INTEGER NOT NULL,
        name       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        PRIMARY KEY (trace_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_trace ON events (trace_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_kind  ON events (trace_id, kind);

      CREATE TABLE IF NOT EXISTS anomalies (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id  TEXT NOT NULL,
        ts        TEXT NOT NULL,
        kind      TEXT NOT NULL,
        severity  TEXT NOT NULL,
        message   TEXT NOT NULL,
        payload   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_anomalies_trace ON anomalies (trace_id);

      CREATE TABLE IF NOT EXISTS events_fts (
        content
      );
    `);
  }

  save(trace: Trace): void {
    const s = trace.summary;
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO traces
            (id, started_at, ended_at, duration_ms, command, cwd, exit_code,
             total_cost_usd, cost_complete, input_tokens, output_tokens,
             llm_calls, tool_calls, file_ops, network_calls, errors, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.id,
          s.startedAt,
          s.endedAt ?? null,
          Math.round(s.durationMs),
          s.command,
          s.cwd,
          s.exitCode ?? null,
          s.totalCostUsd,
          s.costComplete ? 1 : 0,
          s.totalInputTokens,
          s.totalOutputTokens,
          s.llmCalls,
          s.toolCalls,
          s.fileOps,
          s.networkRequests,
          s.errors,
          JSON.stringify(s),
        );

      for (const event of trace.events) {
        this.insertEvent.run(
          event.id,
          s.id,
          event.seq,
          event.kind,
          event.ts,
          Math.round(event.offsetMs),
          event.name,
          JSON.stringify(event),
        );
      }
      for (const anomaly of s.anomalies) {
        this.insertAnomaly.run(
          s.id,
          anomaly.ts,
          anomaly.kind,
          anomaly.severity,
          anomaly.message,
          JSON.stringify(anomaly),
        );
      }
    });
    write();
  }

  /** Append events to an already-saved trace, for a live-writing session. */
  appendEvents(traceId: string, events: readonly TraceEvent[]): void {
    const write = this.db.transaction(() => {
      for (const event of events) {
        this.insertEvent.run(
          event.id,
          traceId,
          event.seq,
          event.kind,
          event.ts,
          Math.round(event.offsetMs),
          event.name,
          JSON.stringify(event),
        );
      }
    });
    write();
  }

  listTraces(limit = 20): TraceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT summary_json FROM traces ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as { summary_json: string }[];
    return rows.map((r) => JSON.parse(r.summary_json) as TraceSummary);
  }

  getSummary(traceId: string): TraceSummary | null {
    const row = this.db.prepare(`SELECT summary_json FROM traces WHERE id = ?`).get(traceId) as
      | { summary_json: string }
      | undefined;
    return row ? (JSON.parse(row.summary_json) as TraceSummary) : null;
  }

  getEvents(traceId: string, options: { kind?: string; limit?: number } = {}): TraceEvent[] {
    const rows = (
      options.kind
        ? this.db
            .prepare(
              `SELECT payload FROM events WHERE trace_id = ? AND kind = ? ORDER BY seq LIMIT ?`,
            )
            .all(traceId, options.kind, options.limit ?? 10_000)
        : this.db
            .prepare(`SELECT payload FROM events WHERE trace_id = ? ORDER BY seq LIMIT ?`)
            .all(traceId, options.limit ?? 10_000)
    ) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as TraceEvent);
  }

  getTrace(traceId: string): Trace | null {
    const summary = this.getSummary(traceId);
    if (!summary) return null;
    return { summary, events: this.getEvents(traceId), version: 1 };
  }

  getAnomalies(traceId: string): Anomaly[] {
    const rows = this.db
      .prepare(`SELECT ts, kind, severity, message, payload FROM anomalies WHERE trace_id = ? ORDER BY id`)
      .all(traceId) as { ts: string; kind: string; severity: string; message: string; payload: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as Omit<Anomaly, 'ts'>), ts: r.ts }));
  }

  /** The most recent trace, which is what `replay` and `compare` default to. */
  latest(): TraceSummary | null {
    return this.listTraces(1)[0] ?? null;
  }

  /** The trace before `traceId`, for a natural "compare with previous run". */
  previous(traceId: string): TraceSummary | null {
    const row = this.db
      .prepare(
        `SELECT summary_json FROM traces WHERE started_at < (SELECT started_at FROM traces WHERE id = ?) ORDER BY started_at DESC LIMIT 1`,
      )
      .get(traceId) as { summary_json: string } | undefined;
    return row ? (JSON.parse(row.summary_json) as TraceSummary) : null;
  }

  deleteTrace(traceId: string): boolean {
    const result = this.db.prepare(`DELETE FROM traces WHERE id = ?`).run(traceId);
    this.db.prepare(`DELETE FROM events WHERE trace_id = ?`).run(traceId);
    this.db.prepare(`DELETE FROM anomalies WHERE trace_id = ?`).run(traceId);
    return result.changes > 0;
  }

  /** Remove every trace. Explicitly destructive; only the CLI calls it. */
  clear(): number {
    const count = this.countTraces();
    this.db.exec(`DELETE FROM traces; DELETE FROM events; DELETE FROM anomalies;`);
    return count;
  }

  countTraces(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM traces`).get() as { n: number };
    return row.n;
  }

  /** Aggregate cost by day, for the report and the dashboard. */
  costByDay(days = 30): { day: string; costUsd: number; llmCalls: number }[] {
    const rows = this.db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS day,
                SUM(total_cost_usd) AS cost,
                SUM(llm_calls) AS calls
         FROM traces
         WHERE started_at >= datetime('now', ?)
         GROUP BY day ORDER BY day`,
      )
      .all(`-${days} days`) as { day: string; cost: number; calls: number }[];
    return rows.map((r) => ({ day: r.day, costUsd: r.cost ?? 0, llmCalls: r.calls ?? 0 }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}