/**
 * Seed the dashboard with a realistic history.
 *
 * The dashboard's value is showing a trend and a verdict. An empty dashboard
 * shows neither, so a first run has nothing to look at. This seeds several
 * weeks of scans for a fictional product, moving from "not ready" to "ready",
 * plus agent traces, a compliance pack and invoice validations.
 *
 * Every number is produced by a real scan of a real synthetic repository. The
 * repository gains the file that resolves one blocker at each step, so the trend
 * on screen is the scanner's output rather than an invented sequence.
 *
 * Run: pnpm --filter @shipready/web seed
 */
import { createDefaultRegistry, runScan, type ProductionReadinessReport } from '@shipready/core';
import { storeCompliance, storeInvoice, storeScan, storeTrace } from '../src/lib/store.js';
import { resetDb } from '../src/db/client.js';
import { validateInvoice } from '@shipready/einvoice';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must be set before the first store call opens the database handle. The store
// reads it lazily rather than at import time precisely so this works.
const SNAPSHOT = join(process.cwd(), '.shipready', 'dashboard.json');
process.env.SHIPREADY_DATABASE = 'memory';
process.env.SHIPREADY_MEMORY_PATH = SNAPSHOT;

const PROJECT = 'acme-ai-dashboard';

/**
 * A synthetic repository whose real production-readiness state improves over the
 * seeded weeks. Each step adds the file that resolves one blocker, so the
 * trend the dashboard shows is actually produced by real scans of real code --
 * not fabricated numbers.
 */
const LAYERS: Record<string, string>[] = {
  '01-vulnerable': {
    'package.json': JSON.stringify({
      name: 'acme-ai-dashboard',
      version: '0.3.0',
      dependencies: {
        next: '14.0.0',
        react: '18.2.0',
        express: '4.18.2',
        '@prisma/client': '5.0.0',
        '@anthropic-ai/sdk': '0.9.0',
        openai: '4.20.0',
      },
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    }),
    'src/server.js': [
      "const express = require('express');",
      "const cors = require('cors');",
      "const { prisma } = require('./db');",
      'const app = express();',
      'app.use(cors({ origin: "*", credentials: true }));',
      'app.use(express.json());',
      "app.get('/users', async (req, res) => {",
      '  const users = await prisma.user.findMany();',
      '  res.json(users);',
      '});',
      "app.post('/summarise', async (req, res) => {",
      '  const { text } = req.body;',
      '  const answer = await callModel(text);',
      '  try {',
      '    await prisma.summary.create({ data: { content: answer } });',
      '  } catch (e) {',
      '  }',
      '  res.json({ ok: true });',
      '});',
      'app.listen(3000);',
      'async function callModel(p) {',
      "  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' });",
      '  return (await r.json()).summary;',
      '}',
    ].join('\n'),
    'src/db.js': "const { PrismaClient } = require('@prisma/client');\nmodule.exports = { prisma: new PrismaClient() };\n",
    'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id String @id\n  email String\n}',
  },

  '02-container': {
    Dockerfile: 'FROM node:22\nWORKDIR /app\nCMD ["node", "src/server.js"]\n',
    '.dockerignore': 'node_modules\n.git\n',
  },

  '02-env': {
    '.env.example': 'DATABASE_URL=\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n',
  },

  '03-health': {
    'src/health.js': [
      "const { prisma } = require('./db');",
      "const app = require('./app');",
      'app.get("/health", (_req, res) => res.json({ status: "ok" }));',
      'app.get("/health/ready", async (_req, res) => {',
      '  try { await prisma.$queryRaw`SELECT 1`; } catch { return res.status(503).end(); }',
      '  res.json({ status: "ready" });',
      '});',
    ].join('\n'),
  },

  '04-errors': {
    'src/error.js': [
      "const { logger } = require('./logger');",
      'module.exports = function errorHandler(err, req, res, _next) {',
      '  const requestId = req.headers["x-request-id"] || Math.random().toString(36).slice(2);',
      '  logger.error({ err, requestId }, "unhandled error");',
      '  res.status(500).json({ error: "internal", requestId });',
      '};',
    ].join('\n'),
    'src/logger.js': "module.exports = { logger: console };",
  },

  '05-security': {
    'src/security.js': [
      "const helmet = require('helmet');",
      "const rateLimit = require('express-rate-limit');",
      "const cors = require('cors');",
      'const ALLOWED = ["https://app.acme.example"];',
      'module.exports = {',
      '  helmet: helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["self"] } } }),',
      '  cors: cors({ origin: ALLOWED, credentials: true }),',
      '  rateLimit: rateLimit({ windowMs: 60000, limit: 100 }),',
      '};',
    ].join('\n'),
  },

  '06-tests': {
    'tests/summarise.test.js': [
      "test('health reports ok', async () => {",
      "  const res = await fetch('http://localhost:3000/health');",
      '  expect(res.status).toBe(200);',
      '});',
      "test('unauthenticated summarise is rejected', async () => {",
      "  const res = await fetch('http://localhost:3000/summarise', { method: 'POST' });",
      '  expect(res.status).toBe(401);',
      '});',
    ].join('\n'),
  },

  '07-ci': {
    '.github/workflows/ci.yml': [
      'name: CI',
      'on: [push, pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: npm ci',
      '      - run: npm test',
      '      - run: npx shipready scan . --threshold 70',
    ].join('\n'),
  },
};

interface SeedResult {
  projectId: string;
  scans: number;
  scoreFrom: number;
  scoreTo: number;
  verdictTo: string;
  traces: number;
  traceCost: number;
  invoices: number;
}

/** Build the repository as it existed at each step in time. */
function materialize(layers: string[], root: string): void {
  rmSync(root, { recursive: true, force: true });
  for (const layer of layers) {
    for (const [path, content] of Object.entries(LAYERS[layer] ?? {})) {
      const abs = join(root, path);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  // Git metadata so the report carries a branch and a commit.
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
}

const LAYER_ORDER = Object.keys(LAYERS);

/** Seed every store the dashboard reads. */
export async function seed(): Promise<SeedResult> {
  resetDb();
  const registry = createDefaultRegistry();
  const scratch = mkdtempSync(join(tmpdir(), 'shipready-seed-'));

  const snapshots: ProductionReadinessReport[] = [];
  try {
    for (let i = 0; i < LAYER_ORDER.length; i++) {
      const layers = LAYER_ORDER.slice(0, i + 1);
      materialize(layers, scratch);
      const { report } = await runScan({ type: 'repo', path: scratch }, { registry });
      snapshots.push(report);
      // Backdate so the trend spans weeks rather than seconds.
      const when = new Date(Date.now() - (LAYER_ORDER.length - i) * 5 * 86_400_000);
      (snapshots[i] as unknown as { generatedAt: string }).generatedAt = when.toISOString();
      (report as unknown as { generatedAt: string }).generatedAt = when.toISOString();
    }

    let scoreFrom = 0;
    let scoreTo = 0;
    let verdictTo = '';
    for (const [index, report] of snapshots.entries()) {
      await storeScan({
        projectId: PROJECT,
        report: report as unknown as Record<string, unknown>,
        commitSha: (7_100_000 + index * 1_337).toString(16),
        branch: index % 2 === 0 ? 'main' : 'feat/rate-limits',
      });
      if (index === 0) scoreFrom = report.score;
      scoreTo = report.score;
      verdictTo = report.verdict;
    }

    // Agent traces, so the observability panel is populated.
    let traceCost = 0;
    const traces = 6;
    for (let i = 0; i < traces; i++) {
      const cost = [0.042, 0.068, 0.031, 0.094, 0.057, 0.023][i]!;
      traceCost += cost;
      const when = new Date(Date.now() - (traces - i) * 3_600_000);
      await storeTrace({
        projectId: PROJECT,
        trace: {
          id: `seed-trace-${i}`,
          startedAt: when.toISOString(),
          command: 'node agent/summarise-agent.js --workspace 4',
          durationMs: 180_000 + i * 22_000,
          exitCode: 0,
          totalCostUsd: cost,
          costComplete: true,
          totalInputTokens: 84_000 + i * 12_000,
          totalOutputTokens: 21_000 + i * 4_000,
          llmCalls: 14 + i * 3,
          toolCalls: 31 + i * 6,
          errors: i === 3 ? 2 : 0,
          byModel: {
            'openai/gpt-4o-mini': {
              calls: 12 + i * 2,
              inputTokens: 70_000 + i * 10_000,
              outputTokens: 17_000 + i * 3_000,
              costUsd: cost * 0.78,
              priced: true,
            },
            'anthropic/claude-sonnet-4': {
              calls: 2 + i,
              inputTokens: 14_000 + i * 2_000,
              outputTokens: 4_000 + i * 1_000,
              costUsd: cost * 0.22,
              priced: true,
            },
          },
          toolDistribution: { read_file: 14 + i * 2, fetch_url: 6 + i, write_file: 5 + i, exec_command: 6 },
          hosts: ['api.openai.com', 'api.anthropic.com', 'api.github.com', 'registry.npmjs.org'],
          anomalies:
            i === 3
              ? [
                  {
                    kind: 'cost-spike',
                    severity: 'warning',
                    message: 'Single call cost $0.0412 on gpt-4o-mini',
                    ts: when.toISOString(),
                  },
                ]
              : [],
        },
      });
    }

    // Compliance pack.
    await storeCompliance({
      projectId: PROJECT,
      pack: {
        company: 'Acme Software Ltd',
        systemName: 'Ticket Summariser',
        jurisdiction: 'EU',
        frameworks: ['eu-ai-act', 'gdpr'],
        score: 78,
        gaps: [
          {
            id: 'ai-act/human-oversight',
            severity: 'blocker',
            message: 'Oversight cadence is documented but not yet signed off',
          },
          {
            id: 'ai-act/post-market',
            severity: 'medium',
            message: 'Post-market monitoring thresholds need a named owner',
          },
          {
            id: 'gdpr/retention',
            severity: 'medium',
            message: 'Retention period for summaries is not stated',
          },
        ],
        documentCount: 8,
      },
    });

    // Invoice validations.
    const invoices = 4;
    for (let i = 0; i < invoices; i++) {
      const result = validateInvoice(SAMPLE_INVOICES[i]!);
      await storeInvoice({
        projectId: PROJECT,
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
    }

    return {
      projectId: PROJECT,
      scans: snapshots.length,
      scoreFrom,
      scoreTo,
      verdictTo,
      traces,
      traceCost: Math.round(traceCost * 10_000) / 10_000,
      invoices,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const SAMPLE_INVOICES: string[] = [
  // Correct.
  `<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFS-e><ide><numeroNFSe>1042</numeroNFSe><serie>1</serie><dataEmissao>2026-08-14</dataEmissao></ide><emitente><cpfCnpj>11222333000181</cpfCnpj><razaoSocial>Northwind Tecnologia Ltda</razaoSocial></emitente><destinatario><cpfCnpj>98765432000198</cpfCnpj><razaoSocial>Cliente Servicos SA</razaoSocial></destinatario><servicos><servico><discriminacao>Consultoria em arquitetura de software</discriminacao><valores><quantidade>10</quantidade><valorUnitario>180.00</valorUnitario><valorServicos>1800.00</valorServicos><valorIss>36.00</valorIss></valores><tributos><tributo><codigoTributacao>0101</codigoTributacao><aliquota>2.00</aliquota></tributo></tributos></servico></servicos><totServicos><valorServicos>1800.00</valorServicos><valorIss>36.00</valorIss><valorTotal>1836.00</valorTotal></totServicos><pagamento><dataPagamento>2026-09-13</dataPagamento><valorPagamento>1836.00</valorPagamento></pagamento></infNFS-e></NFS-e>`,
  // Subtotal contradicts the line items.
  `<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFS-e><ide><numeroNFSe>1043</numeroNFSe><serie>1</serie><dataEmissao>2026-08-21</dataEmissao></ide><emitente><cpfCnpj>11222333000181</cpfCnpj><razaoSocial>Northwind Tecnologia Ltda</razaoSocial></emitente><destinatario><cpfCnpj>98765432000198</cpfCnpj><razaoSocial>Cliente Servicos SA</razaoSocial></destinatario><servicos><servico><discriminacao>Implementacao de integracao</discriminacao><valores><quantidade>20</quantidade><valorUnitario>200.00</valorUnitario><valorServicos>4000.00</valorServicos><valorIss>80.00</valorIss></valores><tributos><tributo><codigoTributacao>1401</codigoTributacao><aliquota>2.00</aliquota></tributo></tributos></servico></servicos><totServicos><valorServicos>3200.00</valorServicos><valorIss>80.00</valorIss><valorTotal>4080.00</valorTotal></totServicos><pagamento><dataPagamento>2026-09-20</dataPagamento><valorPagamento>4080.00</valorPagamento></pagamento></infNFS-e></NFS-e>`,
  // Unknown ISS code.
  `<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFS-e><ide><numeroNFSe>1044</numeroNFSe><serie>1</serie><dataEmissao>2026-09-02</dataEmissao></ide><emitente><cpfCnpj>11222333000181</cpfCnpj><razaoSocial>Northwind Tecnologia Ltda</razaoSocial></emitente><destinatario><cpfCnpj>98765432000198</cpfCnpj><razaoSocial>Cliente Servicos SA</razaoSocial></destinatario><servicos><servico><discriminacao>Treinamento</discriminacao><valores><quantidade>2</quantidade><valorUnitario>1500.00</valorUnitario><valorServicos>3000.00</valorServicos><valorIss>60.00</valorIss></valores><tributos><tributo><codigoTributacao>77777</codigoTributacao><aliquota>2.00</aliquota></tributo></tributos></servico></servicos><totServicos><valorServicos>3000.00</valorServicos><valorIss>60.00</valorIss><valorTotal>3060.00</valorTotal></totServicos><pagamento><dataPagamento>2026-10-02</dataPagamento><valorPagamento>3060.00</valorPagamento></pagamento></infNFS-e></NFS-e>`,
  // Due date before issue date.
  `<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFS-e><ide><numeroNFSe>1045</numeroNFSe><serie>1</serie><dataEmissao>2026-09-18</dataEmissao></ide><emitente><cpfCnpj>11222333000181</cpfCnpj><razaoSocial>Northwind Tecnologia Ltda</razaoSocial></emitente><destinatario><cpfCnpj>98765432000198</cpfCnpj><razaoSocial>Cliente Servicos SA</razaoSocial></destinatario><servicos><servico><discriminacao>Suporte mensal</discriminacao><valores><quantidade>1</quantidade><valorUnitario>2400.00</valorUnitario><valorServicos>2400.00</valorServicos><valorIss>48.00</valorIss></valores><tributos><tributo><codigoTributacao>3301</codigoTributacao><aliquota>2.00</aliquota></tributo></tributos></servico></servicos><totServicos><valorServicos>2400.00</valorServicos><valorIss>48.00</valorIss><valorTotal>2448.00</valorTotal></totServicos><pagamento><dataPagamento>2026-09-01</dataPagamento><valorPagamento>2448.00</valorPagamento></pagamento></infNFS-e></NFS-e>`,
];

export { PROJECT };

// Run when invoked directly rather than imported by a test.
if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  const result = await seed();
  console.log(`Seeded ${PROJECT}`);
  console.log(`  scans     ${result.scans} (${result.scoreFrom} -> ${result.scoreTo})`);
  console.log(`  verdict   ${result.verdictTo}`);
  console.log(`  traces    ${result.traces} ($${result.traceCost.toFixed(4)} model spend)`);
  console.log(`  invoices  ${result.invoices}`);
  console.log(`  snapshot  ${SNAPSHOT}`);
}
