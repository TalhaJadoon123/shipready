import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultRegistry, runScan, type ProductionReadinessReport } from '@shipready/core';
import { validateInvoice, fixInvoice, SUPPORTED } from '@shipready/einvoice';
import { generate, buildDashboard, formatComplianceReport } from '@shipready/compliance';
import { listFindings, latestScan, storeScan, trends } from './store.js';

/**
 * Store tests against the in-memory driver.
 *
 * The dashboard is only useful if the numbers it shows come from the same
 * report the CLI produced. These tests walk a real report through the store and
 * back out through the queries the API routes use, so a mismatch between what
 * is stored and what is displayed fails here rather than in a browser.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-web-'));
  process.env.SHIPREADY_DATABASE = 'memory';
  // The file-backed store is the default outside tests; an empty path turns it
  // back into a purely in-process one so each test starts from nothing.
  process.env.SHIPREADY_MEMORY_PATH = '';
  // The store caches its handle, so a new test needs a new process-level one.
  const { resetDb } = await import('../db/client.js');
  resetDb();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A real report, produced by scanning a real repository. */
async function realReport(): Promise<ProductionReadinessReport> {
  const { report } = await runScan(
    {
      type: 'repo',
      path: process.cwd(),
    },
    { registry: createDefaultRegistry() },
  );
  return report;
}

describe('the scan store', () => {
  it('stores a report and reads it back with the same score', async () => {
    const report = await realReport();
    const stored = await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });

    expect(stored.score).toBe(report.score);
    expect(stored.grade).toBe(report.grade);
    expect(stored.verdict).toBe(report.verdict);

    const latest = await latestScan('p1');
    expect(latest?.score).toBe(report.score);
    expect(latest?.blockers).toBe(report.summary.blockers);
  });

  it('denormalises findings so they can be filtered', async () => {
    const report = await realReport();
    await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });

    const findings = (await listFindings('p1')) as Record<string, unknown>[];
    expect(findings.length).toBe(report.findings.length);

    const first = findings[0]!;
    expect(first).toHaveProperty('ruleId');
    expect(first).toHaveProperty('severity');
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('line');
  });

  it('flattens categories into a keyed object for the radar', async () => {
    const report = await realReport();
    const stored = await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });
    expect(stored.scanId).toBeGreaterThan(0);

    const latest = await latestScan('p1');
    const categories = latest!.categories as Record<string, { score: number }>;
    expect(Object.keys(categories).length).toBe(report.categories.length);
    for (const category of report.categories) {
      expect(categories[category.category]?.score).toBe(category.score);
    }
  });

  it('keeps scans separate per project', async () => {
    const report = await realReport();
    await storeScan({ projectId: 'a', report: report as unknown as Record<string, unknown> });
    await storeScan({ projectId: 'b', report: report as unknown as Record<string, unknown> });

    expect(await listFindings('a')).toHaveLength(report.findings.length);
    expect(await listFindings('b')).toHaveLength(report.findings.length);
  });

  it('keeps the original report intact alongside the denormalised columns', async () => {
    const report = await realReport();
    await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });

    const latest = (await latestScan('p1')) as unknown as {
      report: { categories: unknown[]; findings: unknown[]; topBlockers?: unknown[] };
      categories: Record<string, unknown>;
    };

    // The radar reads the keyed map...
    expect(latest.categories).toBeTypeOf('object');
    // ...while anything rendering the report needs the array it started as.
    expect(Array.isArray(latest.report.categories)).toBe(true);
    expect(latest.report.categories).toHaveLength(report.categories.length);
    expect(Array.isArray(latest.report.findings)).toBe(true);
    expect(latest.report.findings).toHaveLength(report.findings.length);
  });

  it('returns nothing for an unknown project', async () => {
    expect(await latestScan('never-scanned')).toBeNull();
    expect(await listFindings('never-scanned')).toEqual([]);
    expect(await trends('never-scanned')).toEqual([]);
  });

  it('returns trends oldest first, which is the order a line chart needs', async () => {
    const report = await realReport();
    await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });
    await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });
    await storeScan({ projectId: 'p1', report: report as unknown as Record<string, unknown> });

    const points = await trends('p1');
    expect(points).toHaveLength(3);
    for (let i = 1; i < points.length; i++) {
      expect(Date.parse(points[i]!.at)).toBeGreaterThanOrEqual(Date.parse(points[i - 1]!.at));
    }
  });

  it('records the commit and branch when supplied', async () => {
    const report = await realReport();
    await storeScan({
      projectId: 'p1',
      report: report as unknown as Record<string, unknown>,
      commitSha: 'abc1234',
      branch: 'feat/ready',
    });
    const latest = await latestScan('p1');
    expect(latest?.commitSha).toBe('abc1234');
    expect(latest?.branch).toBe('feat/ready');
  });

  it('handles a report with no findings', async () => {
    const report = await realReport();
    // A clean scan: no findings, and a summary that agrees with them.
    const empty = {
      ...report,
      findings: [],
      topBlockers: [],
      summary: { ...report.summary, totalFindings: 0, blockers: 0 },
    } as ProductionReadinessReport;
    await storeScan({ projectId: 'empty', report: empty as unknown as Record<string, unknown> });
    expect(await listFindings('empty')).toEqual([]);
    expect((await latestScan('empty'))?.blockers).toBe(0);
  });
});

describe('traces, compliance and invoices', () => {
  it('records a trace summary and totals it', async () => {
    const { storeTrace, listTraces } = await import('./store.js');
    for (const cost of [0.01, 0.02]) {
      await storeTrace({
        projectId: 'p1',
        trace: {
          id: `t-${cost}`,
          startedAt: new Date().toISOString(),
          command: 'node agent.js',
          totalCostUsd: cost,
          costComplete: true,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          llmCalls: 2,
          toolCalls: 1,
          errors: 0,
        },
      });
    }
    const traces = await listTraces('p1');
    expect(traces).toHaveLength(2);
    const total = traces.reduce((sum, t) => sum + t.totalCostUsd, 0);
    expect(Math.round(total * 1000) / 1000).toBeCloseTo(0.03, 6);
  });

  it('records a compliance pack version without storing the documents', async () => {
    const { storeCompliance, listCompliance } = await import('./store.js');
    const { complianceId } = await storeCompliance({
      projectId: 'p1',
      pack: {
        company: 'Northwind Analytics Ltd',
        systemName: 'Insight',
        jurisdiction: 'EU',
        frameworks: ['eu-ai-act', 'gdpr'],
        score: 92,
        gaps: [],
        documentCount: 8,
      },
    });
    expect(complianceId).toBeGreaterThan(0);
    const packs = await listCompliance('p1');
    expect(packs).toHaveLength(1);
    expect(packs[0]!.score).toBe(92);
    expect(packs[0]!.company).toBe('Northwind Analytics Ltd');
  });

  it('builds a compliance dashboard from a generated pack', async () => {
    const answer = {
      version: 1,
      completedAt: new Date().toISOString(),
      company: {
        legalName: 'Northwind Analytics Ltd',
        registrationNumber: '12345678',
        jurisdiction: 'EU',
        country: 'Portugal',
        countryCode: 'PT',
        sector: 'software',
        employeeCount: 18,
        annualRevenueEur: 1_800_000,
        contactEmail: 'c@example.com',
      },
      aiSystem: {
        name: 'Insight',
        purpose: 'Summarise tickets',
        description: 'Summarises support tickets for agents',
        role: 'deployer',
        riskClass: 'limited',
        intendedPurpose: 'Reduce handling time',
        deploymentContexts: ['internal-business'],
        usersAffected: ['Agents'],
        modelProviders: ['openai'],
        models: ['gpt-4o-mini'],
        usesGpai: true,
        automatedDecisionMaking: false,
        humanOversightMeasures: ['Agent reviews every summary'],
        dataCategories: ['contact'],
        processesSpecialCategory: false,
        lawfulnessBasis: ['contract'],
        dataProvenance: 'Customer tickets',
        loggingEnabled: true,
        loggingDetail: 'Model, user, tokens',
        robustnessMeasures: [],
        cybersecurityMeasures: [],
      },
      frameworks: [],
    };

    const result = generate(answer as never);
    expect(result.documents.length).toBeGreaterThan(0);

    const dashboard = buildDashboard(result);
    expect(dashboard.frameworks.length).toBeGreaterThan(0);
    expect(formatComplianceReport(dashboard)).toContain('Compliance readiness');
  });

  it('validates an invoice through the store', async () => {
    const { storeInvoice, listInvoices } = await import('./store.js');
    const result = validateInvoice(
      [
        '<?xml version="1.0"?>',
        '<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse">',
        '<infNFS-e><ide><numeroNFSe>42</numeroNFSe><serie>1</serie>',
        '<dataEmissao>2026-01-15</dataEmissao></ide>',
        '<emitente><cpfCnpj>11222333000181</cpfCnpj>',
        '<razaoSocial>Northwind</razaoSocial></emitente>',
        '<destinatario><cpfCnpj>98765432000198</cpfCnpj>',
        '<razaoSocial>Cliente</razaoSocial></destinatario>',
        '<servicos><servico><discriminacao>Consultoria</discriminacao><valores>',
        '<quantidade>1</quantidade><valorUnitario>1000.00</valorUnitario>',
        '<valorServicos>1000.00</valorServicos><valorIss>20.00</valorIss></valores>',
        '<tributos><tributo><codigoTributacao>0101</codigoTributacao>',
        '<aliquota>2.00</aliquota></tributo></tributos></servico></servicos>',
        '<totServicos><valorServicos>1000.00</valorServicos>',
        '<valorIss>20.00</valorIss><valorTotal>1020.00</valorTotal></totServicos>',
        '<pagamento><dataPagamento>2026-02-14</dataPagamento>',
        '<valorPagamento>1020.00</valorPagamento></pagamento>',
        '</infNFS-e></NFS-e>',
      ].join('\n'),
    );

    expect(result.valid).toBe(true);

    const { invoiceId } = await storeInvoice({
      projectId: 'p1',
      country: result.country,
      documentType: result.documentType,
      number: result.documentNumber,
      issuer: result.issuer,
      total: result.total,
      currency: result.currency,
      valid: result.valid,
      score: result.score,
      issues: result.issues,
    });
    expect(invoiceId).toBeGreaterThan(0);

    const invoices = await listInvoices('p1');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.valid).toBe(true);
    expect(invoices[0]!.total).toBe(1020);
  });

  it('fixes an invoice with bad arithmetic before validating it', async () => {
    const broken = [
      '<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse">',
      '<infNFS-e><ide><numeroNFSe>42</numeroNFSe><serie>1</serie>',
      '<dataEmissao>2026-01-15</dataEmissao></ide>',
      '<emitente><cpfCnpj>11222333000181</cpfCnpj>',
      '<razaoSocial>Northwind</razaoSocial></emitente>',
      '<destinatario><cpfCnpj>98765432000198</cpfCnpj>',
      '<razaoSocial>Cliente</razaoSocial></destinatario>',
      '<servicos><servico><discriminacao>Consultoria</discriminacao><valores>',
      '<quantidade>10</quantidade><valorUnitario>100.00</valorUnitario>',
      '<valorServicos>1000.00</valorServicos><valorIss>20.00</valorIss></valores>',
      '<tributos><tributo><codigoTributacao>0101</codigoTributacao>',
      '<aliquota>2.00</aliquota></tributo></tributos></servico></servicos>',
      '<totServicos><valorServicos>500.00</valorServicos>',
      '<valorIss>20.00</valorIss><valorTotal>520.00</valorTotal></totServicos>',
      '<pagamento><dataPagamento>2026-02-14</dataPagamento>',
      '<valorPagamento>520.00</valorPagamento></pagamento>',
      '</infNFS-e></NFS-e>',
    ].join('\n');

    const before = validateInvoice(broken);
    expect(before.valid).toBe(false);

    const fixed = fixInvoice(broken);
    expect(fixed.changes).toBeGreaterThan(0);
    expect(fixed.document.subtotal).toBe(1000);

    const after = validateInvoice(fixed.document);
    expect(after.valid).toBe(true);
  });

  it('declares the countries it supports', () => {
    expect(SUPPORTED.map((s) => s.country)).toContain('BR');
  });
});

/**
 * Snapshot persistence.
 *
 * A separate `describe` because these tests are about the store surviving a
 * process, which means juggling the module-level cache: `resetDb()` drops the
 * handle, and the next call re-reads the file. Without that, "it persisted"
 * would pass even if nothing was ever written.
 */
describe('the file-backed store', () => {
  beforeEach(() => {
    process.env.SHIPREADY_DATABASE = 'memory';
    const path = join(dir, 'nested', 'dashboard.json');
    process.env.SHIPREADY_MEMORY_PATH = path;
    // Each test must start from a clean file; the previous test may have left
    // nextScanId advanced, which would make id assertions fail.
    try { unlinkSync(path); } catch {}
  });

  it('writes a snapshot and reads it back in a fresh handle', async () => {
    const { resetDb } = await import('../db/client.js');

    await storeScan({
      projectId: 'p1',
      report: { score: 77, grade: 'C', verdict: 'NEEDS WORK', summary: { totalFindings: 3, blockers: 1 } },
    });
    resetDb();

    const latest = await latestScan('p1');
    expect(latest?.score).toBe(77);
    expect(latest?.grade).toBe('C');
    expect(latest?.blockers).toBe(1);
  });

  it('keeps ids unique across a reload rather than restarting the sequence', async () => {
    const { resetDb } = await import('../db/client.js');

    const report = { score: 50, grade: 'F', verdict: 'NOT READY', summary: { totalFindings: 0, blockers: 0 } };
    await storeScan({ projectId: 'p1', report });
    await storeScan({ projectId: 'p1', report });
    resetDb();

    await storeScan({ projectId: 'p1', report });
    expect((await latestScan('p1'))?.id).toBe(3);
  });

  it('starts empty rather than throwing when the snapshot is corrupt', async () => {
    const { resetDb } = await import('../db/client.js');
    resetDb();

    await storeScan({ projectId: 'p1', report: { score: 10, summary: {} } });
    resetDb();
    // Truncate the file mid-object, the way a killed process would.
    const { writeFile, readFile } = await import('node:fs/promises');
    const raw = await readFile(process.env.SHIPREADY_MEMORY_PATH!, 'utf8');
    await writeFile(process.env.SHIPREADY_MEMORY_PATH!, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
    resetDb();

    expect(await latestScan('p1')).toBeNull();
    // And the next write replaces the bad file rather than appending to it.
    await storeScan({ projectId: 'p1', report: { score: 20, summary: {} } });
    expect((await latestScan('p1'))?.score).toBe(20);
  });

  it('preserves timestamps through the round trip', async () => {
    const { resetDb } = await import('../db/client.js');
    const { storeTrace, listTraces } = await import('./store.js');
    const startedAt = new Date('2026-03-04T05:06:07.000Z').toISOString();

    await storeTrace({ projectId: 'p1', trace: { id: 't1', startedAt, command: 'node a.js', totalCostUsd: 0.5 } });
    resetDb();

    const [trace] = await listTraces('p1');
    // A snapshot turns Date into a string; if it were not revived, sorting by
    // startedAt would throw on the missing method rather than return nothing.
    expect(trace!.startedAt).toBeInstanceOf(Date);
    expect(trace!.startedAt.toISOString()).toBe(startedAt);
  });

  afterEach(() => {
    process.env.SHIPREADY_MEMORY_PATH = '';
  });
});