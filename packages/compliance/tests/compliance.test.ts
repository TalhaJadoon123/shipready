import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate, filenameFor, listTemplateFiles } from '../src/generate.js';
import { findGaps, inferFrameworks, isCsrdInScope, complianceScore, sortGaps } from '../src/types.js';
import { QUESTIONS, parseAnswer, questionFlow, suggestFrameworks } from '../src/questionnaire.js';
import { scanForCompliance, formatScanFindings, findingsToGaps } from '../src/scan.js';
import { buildDashboard, formatComplianceReport } from '../src/dashboard.js';
import { toMarkdownBundle, toJsonBundle, toDocxBundle, buildManifest, zipSync } from '../src/export.js';
import type { ComplianceAnswer } from '../src/types.js';

/**
 * Two sample company profiles: one small EU SaaS that is fully in scope, and
 * one that sits under the CSRD threshold. Both exercise the same questionnaire.
 */
const SMALL_EU_SME: ComplianceAnswer = {
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
    securityContact: 'security@northwind.example',
    dpoName: 'Ana Silva',
    dpoEmail: 'dpo@northwind.example',
  },
  aiSystem: {
    name: 'Insight',
    purpose: 'Summarise customer support tickets so agents triage faster.',
    description:
      'A summarisation assistant that reads a support ticket and produces a short summary with suggested tags. It does not make decisions and its output is always reviewed by an agent.',
    role: 'deployer',
    riskClass: 'limited',
    riskRationale:
      'The system produces text summaries for human review. It does not decide eligibility, access or pricing, so it falls under Article 50 transparency rather than Annex III.',
    intendedPurpose: 'Reduce support agent handling time by summarising inbound tickets.',
    deploymentContexts: ['consumer', 'internal-business'],
    usersAffected: ['Customer support agents', 'Customers whose tickets are summarised'],
    modelProviders: ['openai', 'anthropic'],
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4'],
    usesGpai: true,
    gpaiModelName: 'gpt-4o-mini',
    gpaiSystemicRisk: false,
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
    anonymisationOrPseudonymisation:
      'Names are replaced with stable internal ids before the ticket is sent to the model; the mapping is never included in the prompt.',
    accuracyMetrics: '92% of sampled summaries rated acceptable by agents over the last 60 days (n=180).',
    evaluationApproach:
      'A 120-case evaluation set built from real tickets, re-run on every prompt or model change. Pass rate must stay above 90%.',
    robustnessMeasures: [
      'Input length is capped at 10,000 characters',
      'Output is validated against a schema before it is stored',
      'Adversarial prompts are in the eval set',
    ],
    cybersecurityMeasures: [
      'Authentication on every route',
      'Input validation at the boundary',
      'Rate limiting',
      'Security headers and CSP',
      'Dependency and secret scanning in CI',
      'Audit logging',
    ],
    biasAssessmentDone: false,
    loggingEnabled: true,
    loggingDetail:
      'Model, user id, request id, token counts, cost and outcome. Prompt and response content is hashed, never stored.',
    retentionOfLogs: '90 days',
    humanOversightOfLogs: 'Reviewed by the Security Lead; sampled monthly.',
    postMarketMonitoringPlan:
      'Weekly eval re-run, monthly review of flagged summaries, and a customer feedback link in the UI. Any drop below 90% accuracy halts rollout.',
    incidentResponseProcess:
      'Sev-1 within 1 hour, Sev-2 within 1 business day. Post-incident review within 5 days. Affected users are notified under GDPR Article 34 where there is risk.',
    conformityAssessmentDone: true,
    ceMarkingObtained: true,
    notifiedBodyEngaged: false,
    registrationInEuDatabase: true,
    riskManagementApproach:
      'We run a quarterly risk review covering the model, the data it sees, and the actions a user can take. Identified risks are recorded with an owner and a review date, and any risk scoring above the acceptance threshold blocks release.',
    complaintsProcess: 'A "report a problem" link on every summary, routed to the Support Operations Lead and logged.',
    dataProtectionImpactAssessment: true,
    dpoConsulted: true,
  },
  frameworks: ['eu-ai-act', 'gdpr'],
  notes: {
    csrdMateriality: 'Not in scope: 18 employees, well below the CSRD threshold.',
  },
};

const CSRD_SCOPE_SME: ComplianceAnswer = {
  ...SMALL_EU_SME,
  company: {
    ...SMALL_EU_SME.company,
    legalName: 'Meridian Manufacturing GmbH',
    employeeCount: 400,
    annualRevenueEur: 180_000_000,
    country: 'Germany',
    countryCode: 'DE',
    sector: 'Industrial manufacturing',
  },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-compliance-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CSRD scope', () => {
  it('excludes a small company', () => {
    expect(isCsrdInScope(SMALL_EU_SME.company)).toBe(false);
  });

  it('includes by employee count', () => {
    expect(isCsrdInScope(CSRD_SCOPE_SME.company)).toBe(true);
  });

  it('includes by turnover with 50+ employees', () => {
    expect(isCsrdInScope({ ...SMALL_EU_SME.company, employeeCount: 60, annualRevenueEur: 12_000_000 })).toBe(true);
  });

  it('includes 10+ employees over EUR 50m', () => {
    expect(isCsrdInScope({ ...SMALL_EU_SME.company, employeeCount: 12, annualRevenueEur: 55_000_000 })).toBe(true);
  });

  it('includes CSRD for the larger profile', () => {
    expect(inferFrameworks(CSRD_SCOPE_SME)).toContain('csrd');
    expect(inferFrameworks(SMALL_EU_SME)).not.toContain('csrd');
  });
});

describe('framework inference', () => {
  it('gives an EU company the AI Act and GDPR', () => {
    const frameworks = inferFrameworks(SMALL_EU_SME);
    expect(frameworks).toContain('eu-ai-act');
    expect(frameworks).toContain('gdpr');
  });

  it('adds NIS2 for a larger, revenue-rich entity', () => {
    const frameworks = inferFrameworks({
      ...SMALL_EU_SME,
      company: { ...SMALL_EU_SME.company, employeeCount: 200, annualRevenueEur: 50_000_000 },
    });
    expect(frameworks).toContain('nis2');
  });

  it('adds SOC 2 for a US or UK entity', () => {
    expect(inferFrameworks({ ...SMALL_EU_SME, company: { ...SMALL_EU_SME.company, jurisdiction: 'UK' } })).toContain('soc2');
  });
});

describe('gap analysis', () => {
  it('reports no gaps for a complete answer', () => {
    expect(findGaps(SMALL_EU_SME)).toEqual([]);
  });

  it('flags a high-risk system with no human oversight as a blocker', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [] },
    });
    const oversight = gaps.find((g) => g.id === 'ai-act/human-oversight');
    expect(oversight?.severity).toBe('blocker');
  });

  it('flags a high-risk system with no accuracy metrics', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', accuracyMetrics: undefined },
    });
    expect(gaps.map((g) => g.id)).toContain('ai-act/accuracy');
  });

  it('flags an incomplete conformity assessment', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', conformityAssessmentDone: false },
    });
    expect(gaps.map((g) => g.id)).toContain('ai-act/conformity');
  });

  it('flags automated decision-making with legal effect', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, automatedDecisionMaking: true },
    });
    expect(gaps.map((g) => g.id)).toContain('gdpr/automated-decisions');
  });

  it('flags special-category data on consent with no consent mechanism', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: {
        ...SMALL_EU_SME.aiSystem,
        processesSpecialCategory: true,
        lawfulnessBasis: ['consent'],
        consentMechanism: undefined,
      },
    });
    expect(gaps.map((g) => g.id)).toContain('gdpr/special-category-consent');
  });

  it('flags CSRD gaps when in scope', () => {
    const gaps = findGaps({ ...CSRD_SCOPE_SME, notes: {} });
    expect(gaps.map((g) => g.id)).toContain('csrd/materiality');
    expect(gaps.map((g) => g.id)).toContain('csrd/emissions');
  });

  it('sorts blockers first', () => {
    const sorted = sortGaps(findGaps({ ...SMALL_EU_SME, aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [], accuracyMetrics: undefined, conformityAssessmentDone: false, registrationInEuDatabase: false } }));
    expect(sorted[0]?.severity).toBe('blocker');
    expect(sorted.at(-1)?.severity).not.toBe('blocker');
  });

  it('scores a complete answer at 100', () => {
    expect(complianceScore(findGaps(SMALL_EU_SME))).toBe(100);
  });

  it('scores down as blockers accumulate', () => {
    const gaps = findGaps({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [], accuracyMetrics: undefined, conformityAssessmentDone: false },
    });
    expect(complianceScore(gaps)).toBeLessThan(50);
  });
});

describe('document generation', () => {
  const result = generate(SMALL_EU_SME);

  it('generates documents for the inferred frameworks', () => {
    expect(result.frameworks).toEqual(['eu-ai-act', 'gdpr']);
    expect(result.documents.length).toBeGreaterThanOrEqual(8);
  });

  it('fills the company details into every document', () => {
    for (const document of result.documents) {
      expect(document.content, document.id).toContain('Northwind Analytics Ltd');
    }
  });

  it('fills the system details', () => {
    const annex = result.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!;
    expect(annex.content).toContain('Insight');
    expect(annex.content).toContain('gpt-4o-mini');
    expect(annex.content).toContain('Northwind');
  });

  it('includes the legal references', () => {
    const annex = result.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!;
    expect(annex.reference).toContain('2024/1689');
    expect(annex.content).toContain('Article 14');
    expect(annex.content).toContain('Article 15');
  });

  it('resolves every placeholder in a complete answer', () => {
    for (const document of result.documents) {
      expect(document.unresolved, `${document.id} -> ${document.unresolved.join(', ')}`).toEqual([]);
      expect(document.content).not.toContain('<<');
    }
  });

  it('marks unresolved values visibly rather than leaving a blank', () => {
    const partial = generate({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', accuracyMetrics: undefined, conformityAssessmentDone: false, registrationInEuDatabase: false },
    });
    // The gap report is what carries a missing answer; the body shows the
    // marker so a reader cannot mistake a blank for an omission.
    const annex = partial.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!;
    expect(annex.content).toContain('NOT PROVIDED');
    expect(annex.content).toContain('Gaps in this document');
    expect(annex.gaps.length).toBeGreaterThan(0);
  });

  it('appends the gap report to affected documents', () => {
    const partial = generate({
      ...SMALL_EU_SME,
      aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [] },
    });
    const annex = partial.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!;
    expect(annex.content).toContain('Gaps in this document');
    expect(annex.content).toContain('human oversight');
    expect(annex.gaps.length).toBeGreaterThan(0);
  });

  it('can omit the gap report', () => {
    const partial = generate(
      { ...SMALL_EU_SME, aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [] } },
      { includeGapReport: false },
    );
    expect(partial.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!.content).not.toContain('Gaps in this document');
  });

  it('generates CSRD documents for an in-scope company', () => {
    const csrd = generate({ ...CSRD_SCOPE_SME, notes: { csrdMateriality: 'Climate and data privacy are material.', ghgScope1: '120 tCO2e', ghgScope2: '410 tCO2e' } });
    expect(csrd.frameworks).toContain('csrd');
    const materiality = csrd.documents.find((d) => d.id === 'csrd/materiality')!;
    expect(materiality.content).toContain('Climate and data privacy are material.');
    const ghg = csrd.documents.find((d) => d.id === 'csrd/ghg-worksheet')!;
    expect(ghg.content).toContain('120 tCO2e');
  });

  it('ships every declared template', () => {
    const files = listTemplateFiles();
    for (const framework of ['eu-ai-act', 'gdpr', 'csrd', 'nis2', 'soc2']) {
      expect(files.some((f) => f.startsWith(framework)), framework).toBe(true);
    }
  });

  it('names files deterministically', () => {
    expect(filenameFor(result.documents[0]!)).toMatch(/^compliance\/.+\/[\w-]+\.md$/);
  });
});

describe('export bundles', () => {
  const result = generate(SMALL_EU_SME);
  const manifest = buildManifest(SMALL_EU_SME, result);

  it('produces a markdown bundle with an index and manifest', () => {
    const bundle = toMarkdownBundle(result, manifest);
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('MANIFEST.md');
    expect(paths.filter((p) => p.endsWith('.md')).length).toBeGreaterThan(8);
  });

  it('lists documents in the index', () => {
    const bundle = toMarkdownBundle(result, manifest);
    const readme = bundle.files.find((f) => f.path === 'README.md')!;
    expect(readme.content).toContain('Technical Documentation');
    expect(readme.content).toContain('Record of Processing Activities');
  });

  it('produces a single JSON bundle', () => {
    const bundle = toJsonBundle(result, manifest);
    expect(bundle.files).toHaveLength(1);
    const parsed = JSON.parse(bundle.files[0]!.content as string);
    expect(parsed.documents.length).toBe(result.documents.length);
    expect(parsed.manifest.company).toBe('Northwind Analytics Ltd');
  });

  it('produces a DOCX bundle', () => {
    const bundle = toDocxBundle(result, manifest);
    const file = bundle.files[0]!;
    expect(file.path).toBe('compliance-pack.docx');
    expect(file.content).toBeInstanceOf(Uint8Array);
    // PK zip magic.
    const bytes = file.content as Uint8Array;
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('carries the disclaimer everywhere', () => {
    expect(manifest.disclaimer).toContain('not legal advice');
    const md = toMarkdownBundle(result, manifest);
    expect(md.files.find((f) => f.path === 'MANIFEST.md')!.content).toContain('not legal advice');
  });

  it('writes a valid ZIP', () => {
    const zip = zipSync([{ name: 'a.txt', data: 'hello' }]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip.length).toBeGreaterThan(100);
  });
});

describe('codebase scan', () => {
  it('finds personal data in logs', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/signup.ts'), "export function logSignup(email: string, password: string) {\n  console.log('signup', { email, password });\n}\n", 'utf8');
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).toContain('compliance/pii-in-logs');
    expect(result.filesScanned).toBe(1);
  });

  it('does not fire on comments', async () => {
    await writeFile(join(dir, 'a.ts'), "// console.log('signup', { email });\nexport const a = 1;\n", 'utf8');
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).not.toContain('compliance/pii-in-logs');
  });

  it('reports personal data not declared in the questionnaire', async () => {
    // `biometric` is an Article 9 category the questionnaire never declared.
    // `email` maps to `contact`, which it did, so it is not reported.
    await writeFile(join(dir, 'b.ts'), 'export interface Profile { biometric: string; email: string }\n', 'utf8');
    const result = await scanForCompliance(dir, { aiSystem: { dataCategories: ['contact'] } });
    expect(result.undeclaredData).toContain('biometric');
    expect(result.undeclaredData).not.toContain('email');
  });

  it('finds a model call with no logging', async () => {
    await writeFile(
      join(dir, 'llm.ts'),
      "import OpenAI from 'openai';\nconst o = new OpenAI();\nexport const run = (p: string) => o.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: p }] });\n",
      'utf8',
    );
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).toContain('compliance/ai-without-logging');
  });

  it('finds model output written without a schema', async () => {
    await writeFile(
      join(dir, 'store.ts'),
      "export async function save() { const c = await run('x'); return db.summaries.create({ data: { content: completion.choices[0].message.content } }); }\n",
      'utf8',
    );
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).toContain('compliance/ai-output-stored');
  });

  it('finds special category data fields', async () => {
    await writeFile(join(dir, 'profile.ts'), 'export type P = { biometric: string; diagnosis: string };\n', 'utf8');
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).toContain('compliance/special-category-data');
  });

  it('reports nothing for a clean tree', async () => {
    await writeFile(join(dir, 'clean.ts'), 'export const add = (a: number, b: number): number => a + b;\n', 'utf8');
    const result = await scanForCompliance(dir);
    expect(result.findings).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('formats findings readably', async () => {
    await writeFile(join(dir, 'a.ts'), "console.log({ email: e });\n", 'utf8');
    const result = await scanForCompliance(dir);
    const text = formatScanFindings(result);
    expect(text).toContain('Scanned');
    expect(text).toContain('gdpr');
  });

  it('converts findings into gap-shaped objects', async () => {
    await writeFile(join(dir, 'a.ts'), "console.log({ email: e });\n", 'utf8');
    const result = await scanForCompliance(dir);
    const gaps = findingsToGaps(result.findings);
    expect(gaps.length).toBe(result.findings.length);
    expect(gaps[0]).toHaveProperty('why');
    expect(gaps[0]).toHaveProperty('action');
  });
});

describe('dashboard', () => {
  it('reports one status per framework', () => {
    const dashboard = buildDashboard(generate(SMALL_EU_SME));
    expect(dashboard.frameworks.map((f) => f.framework).sort()).toEqual(['eu-ai-act', 'gdpr']);
  });

  it('marks a complete framework ready', () => {
    const dashboard = buildDashboard(generate(SMALL_EU_SME));
    expect(dashboard.frameworks.every((f) => f.ready)).toBe(true);
    expect(dashboard.blockers).toBe(0);
  });

  it('is not ready when blockers remain', () => {
    const dashboard = buildDashboard(
      generate({ ...SMALL_EU_SME, aiSystem: { ...SMALL_EU_SME.aiSystem, riskClass: 'high', humanOversightMeasures: [] } }),
    );
    expect(dashboard.blockers).toBeGreaterThan(0);
    expect(dashboard.frameworks.some((f) => !f.ready)).toBe(true);
    expect(dashboard.nextAction).not.toBe('');
    expect(dashboard.estimatedDaysToReady).toBeGreaterThan(0);
  });

  it('includes scan results when supplied', () => {
    const dashboard = buildDashboard(generate(SMALL_EU_SME), {
      findings: [1, 2, 3].map((i) => ({
        id: `x${i}`,
        title: 't',
        description: 'd',
        severity: 'high' as const,
        framework: 'gdpr' as const,
        article: 'Art. 5',
        locations: [],
        remediation: 'r',
      })),
      undeclaredData: ['healthStatus'],
      filesScanned: 100,
      durationMs: 5,
    });
    expect(dashboard.scan).toEqual({ findings: 3, undeclaredData: 1, filesScanned: 100 });
  });

  it('formats as readable text', () => {
    const text = formatComplianceReport(buildDashboard(generate(SMALL_EU_SME)));
    expect(text).toContain('Compliance readiness');
    expect(text).toContain('EU AI Act');
  });
});

describe('questionnaire', () => {
  it('has no duplicate ids', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every question', () => {
    for (const q of QUESTIONS) expect(q.id).toMatch(/^(company|ai)\./);
  });

  it('explains why each question is asked', () => {
    for (const q of QUESTIONS) expect(q.why.length, q.id).toBeGreaterThan(20);
  });

  it('covers the EU AI Act, GDPR and CSRD questions', () => {
    const ids = QUESTIONS.map((q) => q.id);
    for (const id of [
      'ai.riskClass',
      'ai.riskRationale',
      'ai.humanOversightMeasures',
      'ai.accuracyMetrics',
      'ai.lawfulnessBasis',
      'ai.dataRetentionPeriod',
      'ai.postMarketMonitoringPlan',
      'company.employeeCount',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('skips conditional questions that do not apply', () => {
    const flow = questionFlow({ aiSystem: { riskClass: 'minimal', lawfulnessBasis: ['contract'] } as never });
    expect(flow.map((q) => q.id)).not.toContain('ai.riskRationale');
    expect(flow.map((q) => q.id)).not.toContain('ai.consentMechanism');
  });

  it('includes conditional questions that do apply', () => {
    const flow = questionFlow({
      aiSystem: { riskClass: 'high', lawfulnessBasis: ['consent'], usesGpai: true } as never,
    });
    expect(flow.map((q) => q.id)).toContain('ai.consentMechanism');
    expect(flow.map((q) => q.id)).toContain('ai.gpaiModelName');
    expect(flow.map((q) => q.id)).toContain('ai.riskRationale');
  });

  it('parses answers by type', () => {
    expect(parseAnswer('yes', 'boolean')).toBe(true);
    expect(parseAnswer('n', 'boolean')).toBe(false);
    expect(parseAnswer('1,240', 'number')).toBe(1240);
    expect(parseAnswer('a, b , c', 'multichoice')).toEqual(['a', 'b', 'c']);
    expect(parseAnswer('hello', 'text')).toBe('hello');
  });

  it('suggests frameworks before the last question is answered', () => {
    expect(suggestFrameworks({ company: SMALL_EU_SME.company, aiSystem: SMALL_EU_SME.aiSystem })).toContain('eu-ai-act');
  });

  it('assigns an answer into the right place', () => {
    const answer: Partial<ComplianceAnswer> = {};
    const company = QUESTIONS.find((q) => q.id === 'company.legalName')!;
    company.assign(answer, 'Acme Ltd');
    expect(answer.company?.legalName).toBe('Acme Ltd');
  });
});

