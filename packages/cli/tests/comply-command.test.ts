import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runComply, runComplianceScan } from '../src/commands/comply.js';
import { writeBundle, type BundleFormat } from '../src/lib/bundle.js';

/**
 * `shipready comply`, against a real answer set and a real directory.
 *
 * The compliance engine itself is covered in the compliance package; what
 * matters here is that the command writes files a person can open, and that it
 * tells the truth about what is still missing.
 */

let dir: string;
const temporary: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-comply-cmd-'));
  temporary.push(dir);
});

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const ANSWER = {
  version: 1,
  completedAt: '2026-01-15T10:00:00.000Z',
  company: {
    legalName: 'Northwind Analytics Ltd',
    tradingName: 'Northwind',
    registrationNumber: '12345678',
    jurisdiction: 'EU',
    country: 'Portugal',
    countryCode: 'PT',
    sector: 'B2B software',
    employeeCount: 18,
    annualRevenueEur: 1_800_000,
    contactEmail: 'compliance@northwind.example',
    privacyEmail: 'privacy@northwind.example',
    dpoName: 'Ana Silva',
    dpoEmail: 'dpo@northwind.example',
  },
  aiSystem: {
    name: 'Insight',
    purpose: 'Summarise support tickets',
    description: 'Summarises tickets so agents triage faster. Output is always reviewed by an agent.',
    role: 'deployer',
    riskClass: 'limited',
    riskRationale:
      'Limited risk: the output is text summaries for human review and never decides eligibility, access or pricing.',
    intendedPurpose: 'Reduce support handling time.',
    deploymentContexts: ['internal-business'],
    usersAffected: ['Support agents', 'Customers whose tickets are summarised'],
    modelProviders: ['openai', 'anthropic'],
    models: ['gpt-4o-mini', 'claude-sonnet-4'],
    usesGpai: true,
    gpaiModelName: 'gpt-4o-mini',
    automatedDecisionMaking: false,
    humanOversightMeasures: [
      'Every summary is shown to an agent before it is saved',
      'Users can flag an incorrect summary',
      'A feature flag disables the feature for the whole workspace',
    ],
    humanOversightResponsible: 'Support Operations Lead',
    dataCategories: ['contact', 'communications'],
    processesSpecialCategory: false,
    lawfulnessBasis: ['contract'],
    dataProvenance: 'Tickets are supplied by customers through our support widget.',
    dataRetentionPeriod: 'Ticket content 24 months; summaries 12 months.',
    anonymisationOrPseudonymisation: 'Names are replaced with stable internal ids before the ticket is sent.',
    accuracyMetrics: '92% of sampled summaries rated acceptable by agents over 60 days (n=180).',
    evaluationApproach: 'A 120-case eval set from real tickets, re-run on every prompt or model change.',
    robustnessMeasures: ['Input capped at 10,000 characters', 'Output validated against a schema'],
    cybersecurityMeasures: [
      'Authentication on every route',
      'Rate limiting',
      'Security headers and CSP',
      'Dependency and secret scanning in CI',
    ],
    loggingEnabled: true,
    loggingDetail: 'Model, user id, request id, tokens, cost, outcome. Content is hashed, never stored.',
    retentionOfLogs: '90 days',
    humanOversightOfLogs: 'Reviewed monthly by the Security Lead.',
    postMarketMonitoringPlan: 'Weekly eval re-run, monthly review of flagged summaries, in-product feedback link.',
    incidentResponseProcess: 'Sev-1 within 1 hour, Sev-2 within 1 business day, review within 5 days.',
    complianceAssessmentDone: true,
    registrationInEuDatabase: true,
    complaintsProcess: 'A report link on every summary, routed to the Support Operations Lead.',
    dataProtectionImpactAssessment: true,
    dpoConsulted: true,
  },
  frameworks: [],
} as never;

describe('shipready comply init', () => {
  it('generates a pack and writes an index and a manifest', async () => {
    const outcome = await runComply({ answer: ANSWER, output: dir, format: 'markdown', json: false, interactive: false });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.documents.length).toBeGreaterThanOrEqual(8);
    expect(existsSync(join(dir, 'MANIFEST.md'))).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);

    const manifest = await readFile(join(dir, 'MANIFEST.md'), 'utf8');
    expect(manifest).toContain('Northwind Analytics Ltd');
    expect(manifest).toContain('not legal advice');
  });

  it('writes one file per document under the framework directory', async () => {
    await runComply({ answer: ANSWER, output: dir, format: 'markdown', json: false, interactive: false });

    const annex = join(dir, 'eu-ai-act', 'annex-iv.md');
    expect(existsSync(annex)).toBe(true);
    const content = await readFile(annex, 'utf8');
    expect(content).toContain('Insight');
    expect(content).toContain('2024/1689');

    // The directory layout is what a person navigating `compliance/` expects.
    const frameworks = await readdir(dir, { withFileTypes: true });
    const dirs = frameworks.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs).toContain('eu-ai-act');
    expect(dirs).toContain('gdpr');
  });

  it('is idempotent apart from the generation date', async () => {
    await runComply({ answer: ANSWER, output: dir, format: 'markdown', json: false, interactive: false });
    const first = await readFile(join(dir, 'eu-ai-act', 'annex-iv.md'), 'utf8');
    await runComply({ answer: ANSWER, output: dir, format: 'markdown', json: false, interactive: false });
    const second = await readFile(join(dir, 'eu-ai-act', 'annex-iv.md'), 'utf8');
    const strip = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}/g, '');
    expect(strip(second)).toBe(strip(first));
  });

  it('writes a DOCX bundle', async () => {
    await runComply({ answer: ANSWER, output: dir, format: 'docx', json: false, interactive: false });
    const docx = join(dir, 'compliance-pack.docx');
    expect(existsSync(docx)).toBe(true);
    const bytes = await readFile(docx);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('writes a JSON bundle', async () => {
    await runComply({ answer: ANSWER, output: dir, format: 'json', json: false, interactive: false });
    const parsed = JSON.parse(await readFile(join(dir, 'compliance-pack.json'), 'utf8'));
    expect(parsed.documents.length).toBeGreaterThan(0);
    expect(parsed.manifest.company).toBe('Northwind Analytics Ltd');
  });

  it('marks every missing value visibly rather than leaving a blank', async () => {
    const incomplete = {
      ...(ANSWER as unknown as Record<string, unknown>),
      aiSystem: {
        ...((ANSWER as unknown as { aiSystem: Record<string, unknown> }).aiSystem),
        riskClass: 'high',
        humanOversightMeasures: [],
      },
    };

    const outcome = await runComply({
      answer: incomplete as never,
      output: dir,
      format: 'markdown',
      json: false,
      interactive: false,
    });

    expect(outcome.gaps.length).toBeGreaterThan(0);
    const annex = await readFile(join(dir, 'eu-ai-act', 'annex-iv.md'), 'utf8');
    expect(annex).toContain('NOT PROVIDED');
    expect(annex).toContain('Gaps in this document');
    // Every gap explains why it matters, not merely what is missing.
    expect(annex).toContain('Why it matters:');
  });

  it('reports a readiness score', async () => {
    const outcome = await runComply({ answer: ANSWER, output: dir, format: 'markdown', json: false, interactive: false });
    expect(outcome.score).toBeGreaterThan(0);
    expect(outcome.score).toBeLessThanOrEqual(100);
  });
});

describe('shipready comply scan', () => {
  it('finds personal data written to logs', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src/signup.ts'),
      "export function logSignup(email: string, password: string) {\n  console.log('signup', { email, password });\n}\n",
      'utf8',
    );

    const outcome = await runComplianceScan({ path: dir, json: false, answer: ANSWER });
    expect(outcome.findings.map((f) => f.id)).toContain('compliance/pii-in-logs');
  });

  it('reports nothing for a clean codebase', async () => {
    await writeFile(join(dir, 'add.ts'), 'export const add = (a: number, b: number): number => a + b;\n', 'utf8');
    const outcome = await runComplianceScan({ path: dir, json: false, answer: ANSWER });
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.exitCode).toBe(0);
  });

  it('flags special-category data the questionnaire never declared', async () => {
    await writeFile(join(dir, 'profile.ts'), 'export type P = { biometric: string; email: string };\n', 'utf8');
    const outcome = await runComplianceScan({ path: dir, json: false, answer: ANSWER });
    expect(outcome.undeclaredData).toContain('biometric');
    expect(outcome.undeclaredData).not.toContain('email');
  });

  it('exits 2 for a path that does not exist', async () => {
    const outcome = await runComplianceScan({ path: join(dir, 'nope'), json: false, answer: ANSWER });
    expect(outcome.exitCode).toBe(2);
  });
});

describe('writing bundles', () => {
  it('creates a missing output directory', async () => {
    const target = join(dir, 'deep', 'nested');
    await writeBundle([], 'markdown', target);
    expect(existsSync(target)).toBe(true);
  });

  it('supports every documented format', async () => {
    const formats: BundleFormat[] = ['markdown', 'json', 'docx'];
    for (const format of formats) {
      const target = join(dir, format);
      await expect(writeBundle([], format, target)).resolves.toBe(target);
      expect(existsSync(target)).toBe(true);
    }
  });

  it('refuses an unknown format', async () => {
    await expect(writeBundle([], 'pdf' as never, dir)).rejects.toThrow(/Unknown/i);
  });

  it('refuses to write outside the output directory', async () => {
    const escape = [
      {
        path: '../../escaped.md',
        content: 'x',
        kind: 'markdown' as const,
        title: 't',
        framework: 'f',
      },
    ];
    // The paths come from template metadata today, but this boundary is what
    // stops a third-party pack turning `../../etc/passwd` into a write.
    await expect(writeBundle(escape, 'markdown', dir)).rejects.toThrow(/outside the output directory/i);
  });
});