import { getDb, createMemoryDatabase, type Driver } from '../db/client.js';

/** The operation surface `lib/store.ts` depends on. */
type Store = ReturnType<typeof createMemoryDatabase>;

/**
 * The store handle, narrowed to the operations below.
 *
 * Only the file-backed in-memory driver implements them today. Selecting
 * Postgres or PGlite gets a named error rather than
 * `db.insertScan is not a function` from the middle of a request, because the
 * Drizzle adapter is the one part of this layer still to be written -- and a
 * deployment that reaches it should be told that plainly rather than discover it
 * as an unhandled rejection.
 */
function store(): Store {
  const db = getDb() as Partial<Store> & { driver?: Driver };
  if (typeof db.insertScan !== 'function') {
    throw new Error(
      `ShipReady dashboard: the '${db.driver ?? 'postgres'}' driver is not wired up yet. ` +
        'Set SHIPREADY_DATABASE=memory to run on the file-backed store.',
    );
  }
  return db as Store;
}

/**
 * Database-backed storage.
 *
 * The memory implementation lives in `client.ts` and covers the operations the
 * API routes need. Traces, compliance packs and invoices are appended there too:
 * they are small, bounded records, and the dashboard reads totals rather than
 * querying across them.
 */

export interface StoredScan {
  scanId: number;
  score: number;
  grade: string;
  verdict: string;
}

export async function storeScan(input: {
  projectId: string;
  report: Record<string, unknown>;
  commitSha?: string;
  branch?: string;
}): Promise<StoredScan> {
  const db = store();

  const report = input.report;
  const categories: Record<string, unknown> = {};
  for (const category of (report.categories ?? []) as Record<string, unknown>[]) {
    const key = String(category.category);
    categories[key] = {
      score: category.score,
      weight: category.weight,
      findings: category.findingCount,
      blockers: category.blockers,
    };
  }

  const record = await db.insertScan(input.projectId, {
    score: Number(report.score ?? 0),
    grade: String(report.grade ?? 'F'),
    verdict: String(report.verdict ?? 'NOT READY'),
    blockers: Number((report.summary as Record<string, unknown>)?.blockers ?? 0),
    findingsCount: Number((report.summary as Record<string, unknown>)?.totalFindings ?? 0),
    categories,
    summary: report.summary ?? {},
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    // The full report is kept so the dashboard can render anything the
    // denormalised tables do not cover, without a second upload.
    report,
  });

  const findings = (report.findings ?? []) as Record<string, unknown>[];
  await db.insertFindings(
    record.id,
    findings.map((finding) => {
      const location = (finding.location ?? {}) as Record<string, unknown>;
      return {
        findingId: String(finding.id),
        ruleId: String(finding.ruleId),
        title: String(finding.title),
        severity: String(finding.severity),
        productionImpact: String(finding.productionImpact),
        category: String(finding.category),
        confidence: Number(finding.confidence ?? 0),
        path: String(location.path ?? ''),
        line: Number(location.startLine ?? 1),
        fixable: Boolean(finding.fixable),
        effortMinutes: Number(finding.effortMinutes ?? 0),
      };
    }),
  );

  return { scanId: record.id, score: record.score, grade: record.grade, verdict: record.verdict };
}

export async function listScans(projectId: string, limit = 50) {
  const db = store();
  return db.listScans(projectId, limit);
}

export async function latestScan(projectId: string) {
  const db = store();
  return db.latestScan(projectId);
}

export async function listFindings(projectId: string, scanId?: number, limit = 200) {
  const db = store();
  const scan = scanId ?? (await db.latestScan(projectId))?.id;
  if (scan === undefined) return [];
  return db.listFindings(scan, limit);
}

export async function trends(projectId: string, limit = 60) {
  const db = store();
  return db.trends(projectId, limit);
}

/**
 * Observed traces, newest first.
 *
 * Traces are summarised on insert rather than re-read from the local SQLite
 * file: the dashboard runs somewhere else and cannot reach the developer's disk.
 */
export async function storeTrace(input: {
  projectId: string;
  trace: Record<string, unknown> & { id: string; startedAt: string; command: string };
}): Promise<{ traceId: string }> {
  const db = store();
  db.recordTrace(input.projectId, input.trace);
  return { traceId: input.trace.id };
}

export async function listTraces(projectId: string, limit = 50) {
  const db = store();
  return db.listTraces(projectId, limit);
}

export async function storeCompliance(input: {
  projectId: string;
  pack: {
    company: string;
    systemName: string;
    jurisdiction: string;
    frameworks: string[];
    score: number;
    gaps: unknown[];
    documentCount: number;
  };
}): Promise<{ complianceId: number }> {
  const db = store();
  return { complianceId: db.recordCompliance(input.projectId, input.pack) };
}

export async function listCompliance(projectId: string, limit = 20) {
  const db = store();
  return db.listCompliance(projectId, limit);
}

export async function storeInvoice(input: {
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
}): Promise<{ invoiceId: number }> {
  const db = store();
  return { invoiceId: db.recordInvoice(input) };
}

export async function listInvoices(projectId: string, limit = 50) {
  const db = store();
  return db.listInvoices(projectId, limit);
}

/** Which driver is in use, so `/api/health` can report it honestly. */
export function currentDriver(): Driver {
  const db = getDb() as { driver?: Driver };
  return db.driver ?? 'postgres';
}