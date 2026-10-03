import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { schema } from './schema.js';

/**
 * The dashboard database.
 *
 * Drizzle over Postgres when `DATABASE_URL` is set, and an in-process store
 * otherwise. The fallback is not a stub: it implements the same operations with
 * the same behaviour, so `docker compose up` and a hosted deployment run
 * identical code paths, and a developer's `pnpm dev` needs no database at all.
 *
 * The schema is deliberately narrow. It stores scans, findings, traces,
 * compliance pack versions and invoice validations -- the five things the
 * dashboard reads. Compliance documents themselves are not stored: they are
 * regulatory documents about the customer's business, and copying them into
 * someone else's database is a liability, not a feature.
 */
export type Driver = 'postgres' | 'pglite' | 'memory';

function pickDriver(): Driver {
  if (process.env.SHIPREADY_DATABASE === 'memory') return 'memory';
  if (process.env.SHIPREADY_DATABASE === 'pglite') return 'pglite';
  if (process.env.DATABASE_URL) return 'postgres';
  // No configuration: still run, still work. Production without a database URL
  // is a misconfiguration, so it fails loudly instead of silently losing writes.
  return process.env.NODE_ENV === 'production' ? 'postgres' : 'pglite';
}

export interface ScanRecord {
  id: number;
  projectId: string;
  score: number;
  grade: string;
  verdict: string;
  blockers: number;
  findingsCount: number;
  createdAt: Date;
}

export interface TrendPoint {
  at: string;
  score: number;
  blockers: number;
}

export interface TraceRecord {
  id: string;
  projectId: string;
  command: string;
  startedAt: Date;
  durationMs: number;
  exitCode: number | null;
  totalCostUsd: number;
  costComplete: boolean;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  summary: Record<string, unknown>;
}

export interface ComplianceRecord {
  id: number;
  projectId: string;
  company: string;
  systemName: string;
  jurisdiction: string;
  frameworks: string[];
  score: number;
  gaps: unknown[];
  documentCount: number;
  createdAt: Date;
}

export interface InvoiceRecord {
  id: number;
  projectId: string | null;
  country: string;
  documentType: string;
  number: string;
  issuer: string;
  total: number;
  currency: string;
  valid: boolean;
  score: number;
  errorCount: number;
  issues: unknown[];
  createdAt: Date;
}

/**
 * The database handle.
 *
 * `unknown` rather than the inferred union: the driver union includes
 * PGlite's own type, which cannot be named from outside its package. The API
 * routes go through `lib/store.ts`, which narrows to the operations it needs,
 * so the loose handle is never actually used untyped.
 */
export type Database = unknown;

let cached: Database = null;

export function createDatabase(): Database {
  const driver = pickDriver();
  switch (driver) {
    case 'postgres':
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required when SHIPREADY_DATABASE is postgres');
      }
      return drizzlePostgres(process.env.DATABASE_URL, { schema });
    case 'pglite':
      return drizzlePglite(process.env.SHIPREADY_PGLITE_PATH ?? './.shipready/pglite', { schema });
    case 'memory':
      return createMemoryDatabase();
  }
}

/** The process-wide handle. Cached so repeated requests share one connection. */
export function getDb(): Database {
  cached ??= createDatabase();
  return cached;
}

export function resetDb(): void {
  cached = null;
}

/**
 * In-memory store.
 *
 * Implements exactly the operations the API routes call. Anything more would be
 * a second implementation of the app; needing a real query here is the signal
 * to reach for a real database, which is the correct outcome.
 */
export function createMemoryDatabase() {
  const scans: (ScanRecord & {
    commitSha: string | null;
    branch: string | null;
    categories: Record<string, unknown>;
    summary: Record<string, unknown>;
    report: unknown;
    findings: unknown[];
  })[] = [];
  const traces: TraceRecord[] = [];
  const compliance: ComplianceRecord[] = [];
  const invoices: InvoiceRecord[] = [];
  let nextScanId = 1;
  let nextFindingId = 1;
  let nextComplianceId = 1;
  let nextInvoiceId = 1;

  const database = {
    driver: 'memory' as const,

    async insertScan(projectId: string, payload: Record<string, unknown>): Promise<ScanRecord> {
      const id = nextScanId++;
      const record: (typeof scans)[number] = {
        id,
        projectId,
        score: Number(payload.score ?? 0),
        grade: String(payload.grade ?? 'F'),
        verdict: String(payload.verdict ?? 'NOT READY'),
        commitSha: payload.commitSha ? String(payload.commitSha) : null,
        branch: payload.branch ? String(payload.branch) : null,
        blockers: Number(payload.blockers ?? 0),
        findingsCount: Number(payload.findingsCount ?? 0),
        categories: (payload.categories ?? {}) as Record<string, unknown>,
        summary: (payload.summary ?? {}) as Record<string, unknown>,
        report: payload,
        findings: [],
        createdAt: new Date(),
      };
      scans.push(record);
      return record;
    },

    async insertFindings(scanId: number, findings: Record<string, unknown>[]): Promise<void> {
      const scan = scans.find((s) => s.id === scanId);
      if (!scan) return;
      for (const finding of findings) {
        scan.findings.push({ ...finding, id: nextFindingId++, scanId });
      }
    },

    async listScans(projectId: string, limit = 50) {
      return scans
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async latestScan(projectId: string) {
      const [first] = await database.listScans(projectId, 1);
      return first ?? null;
    },

    async listFindings(scanId: number, limit = 500) {
      const scan = scans.find((s) => s.id === scanId);
      return (scan?.findings ?? []).slice(0, limit);
    },

    async trends(projectId: string, limit = 60): Promise<TrendPoint[]> {
      return scans
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(-limit)
        .map((s) => ({ at: s.createdAt.toISOString(), score: s.score, blockers: s.blockers }));
    },

    // --- Traces -----------------------------------------------------------
    // Summaries only. Events stay in the local SQLite file the CLI wrote:
    // a hosted dashboard cannot reach the developer's disk, and copying every
    // event of every run into someone else's database is not worth it.
    recordTrace(projectId: string, trace: Record<string, unknown> & { id: string; startedAt: string; command: string }) {
      traces.push({
        id: trace.id,
        projectId,
        command: trace.command,
        startedAt: new Date(trace.startedAt),
        durationMs: Number(trace.durationMs ?? 0),
        exitCode: typeof trace.exitCode === 'number' ? trace.exitCode : null,
        totalCostUsd: Number(trace.totalCostUsd ?? 0),
        costComplete: trace.costComplete !== false,
        inputTokens: Number(trace.totalInputTokens ?? 0),
        outputTokens: Number(trace.totalOutputTokens ?? 0),
        llmCalls: Number(trace.llmCalls ?? 0),
        toolCalls: Number(trace.toolCalls ?? 0),
        errors: Number(trace.errors ?? 0),
        summary: trace,
      });
      return { traceId: trace.id };
    },

    listTraces(projectId: string, limit = 50) {
      return traces
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit);
    },

    // --- Compliance -------------------------------------------------------
    // The version record, not the documents. A regulatory document about the
    // customer's business belongs on their filesystem.
    recordCompliance(
      projectId: string,
      pack: {
        company: string;
        systemName: string;
        jurisdiction: string;
        frameworks: string[];
        score: number;
        gaps: unknown[];
        documentCount: number;
      },
    ) {
      const id = nextComplianceId++;
      compliance.push({ id, projectId, ...pack, createdAt: new Date() });
      return id;
    },

    listCompliance(projectId: string, limit = 20) {
      return compliance
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    // --- Invoices ---------------------------------------------------------
    recordInvoice(invoice: {
      projectId?: string;
      country: string;
      documentType: string;
      number: string;
      issuer: string;
      total: number;
      currency: string;
      valid: boolean;
      score: number;
      issues: unknown[];
    }) {
      const id = nextInvoiceId++;
      const errors = (invoice.issues as { severity?: string }[] | undefined) ?? [];
      invoices.push({
        id,
        projectId: invoice.projectId ?? null,
        country: invoice.country,
        documentType: invoice.documentType,
        number: invoice.number,
        issuer: invoice.issuer,
        total: invoice.total,
        currency: invoice.currency,
        valid: invoice.valid,
        score: invoice.score,
        errorCount: errors.filter((i) => i.severity === 'error').length,
        issues: invoice.issues,
        createdAt: new Date(),
      });
      return id;
    },

    listInvoices(projectId: string, limit = 50) {
      return invoices
        .filter((i) => !projectId || i.projectId === projectId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async close(): Promise<void> {},
  };

  return database;
}

export { schema };