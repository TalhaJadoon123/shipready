import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { QUESTIONS, questionFlow, parseAnswer, suggestFrameworks, type Question } from '../src/questionnaire.js';
import { findGaps, inferFrameworks, isCsrdInScope, complianceScore, sortGaps } from '../src/types.js';
import { generate, listTemplateFiles } from '../src/generate.js';
import { toDocxBundle, zipSync, buildManifest } from '../src/export.js';
import { scanForCompliance } from '../src/scan.js';
import type { ComplianceAnswer, CompanyProfile, AiSystemProfile } from '../src/types.js';

/**
 * The compliance module tested through the CLI's interactive flow.
 *
 * The unit-level behaviour is covered in compliance.test.ts; what matters here
 * is the end-to-end path: a person answers the questions, the answers come out
 * as a document pack, and the pack carries its own gaps.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-comply-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Answer every applicable question as the questionnaire asks. */
function answerAll(overrides: Partial<ComplianceAnswer> = {}): ComplianceAnswer {
  const base: Partial<ComplianceAnswer> = {
    company: {
      legalName: 'Northwind Analytics Ltd',
      registrationNumber: '12345678',
      jurisdiction: 'EU',
      country: 'Portugal',
      countryCode: 'PT',
      sector: 'B2B software',
      employeeCount: 18,
      annualRevenueEur: 1_800_000,
      contactEmail: 'compliance@northwind.example',
    } as CompanyProfile,
    aiSystem: {
      name: 'Insight',
      purpose: 'Summarise support tickets',
      description: 'Summarises tickets so agents triage faster',
      role: 'deployer',
      riskClass: 'limited',
      riskRationale: 'Limited risk: the output is reviewed by a human and never decides eligibility.',
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
      dataRetentionPeriod: '24 months',
      complianceAssessmentDone: true,
      registrationInEuDatabase: true,
      accuracyMetrics: '92% of sampled summaries rated acceptable (n=180).',
      evaluationApproach: 'A 120-case eval set, re-run on every prompt change.',
      loggingEnabled: true,
      loggingDetail: 'Model, user, tokens',
      complaintsProcess: 'A report link on every summary, logged.',
      robustnessMeasures: ['Input capped'],
      cybersecurityMeasures: ['Auth on every route'],
    } as AiSystemProfile,
    frameworks: [],
  };

  const answer = { ...base, ...overrides } as ComplianceAnswer;
  return answer;
}

describe('the questionnaire', () => {
  it('has no duplicate ids', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every question', () => {
    for (const q of QUESTIONS) expect(q.id, q.id).toMatch(/^(company|ai)\./);
  });

  it('explains why each question is asked', () => {
    for (const q of QUESTIONS) {
      expect(q.why.length, q.id).toBeGreaterThan(20);
    }
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
    const flow = questionFlow({
      aiSystem: { riskClass: 'minimal', lawfulnessBasis: ['contract'] } as never,
    });
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

  it('parses each answer type', () => {
    expect(parseAnswer('yes', 'boolean')).toBe(true);
    expect(parseAnswer('n', 'boolean')).toBe(false);
    expect(parseAnswer('1,240', 'number')).toBe(1240);
    expect(parseAnswer('a, b , c', 'multichoice')).toEqual(['a', 'b', 'c']);
    expect(parseAnswer('hello', 'text')).toBe('hello');
  });

  it('assigns an answer into the right place', () => {
    const answer: Partial<ComplianceAnswer> = {};
    const company = QUESTIONS.find((q) => q.id === 'company.legalName')!;
    company.assign(answer, 'Acme Ltd');
    expect(answer.company?.legalName).toBe('Acme Ltd');
  });

  it('can be answered end to end by iterating the flow', () => {
    // Simulate what the CLI does: build the flow, answer each question, assign.
    const flow: Question[] = questionFlow({});
    const answer: Partial<ComplianceAnswer> = { aiSystem: {}, company: {} };
    const responses: Record<string, string> = {
      'company.legalName': 'Northwind Analytics Ltd',
      'company.registrationNumber': '12345678',
      'company.jurisdiction': 'EU',
      'company.country': 'Portugal',
      'company.countryCode': 'PT',
      'company.sector': 'software',
      'company.employeeCount': '18',
      'company.annualRevenueEur': '1800000',
      'company.contactEmail': 'c@example.com',
      'ai.name': 'Insight',
      'ai.riskClass': 'limited',
      'ai.intendedPurpose': 'Reduce handling time',
    };
    for (const question of flow) {
      const response = responses[question.id];
      if (response === undefined) continue;
      question.assign(answer, parseAnswer(response, question.type));
    }
    expect(answer.company?.legalName).toBe('Northwind Analytics Ltd');
    expect(answer.aiSystem?.riskClass).toBe('limited');
  });

  it('suggests frameworks before the last question', () => {
    expect(suggestFrameworks(answerAll())).toContain('eu-ai-act');
  });
});

describe('CSRD scope', () => {
  it('excludes a small company', () => {
    const company = { employeeCount: 18, annualRevenueEur: 1_800_000 } as CompanyProfile;
    expect(isCsrdInScope(company)).toBe(false);
  });

  it('includes by employee count', () => {
    const company = { employeeCount: 400, annualRevenueEur: 180_000_000 } as CompanyProfile;
    expect(isCsrdInScope(company)).toBe(true);
  });

  it('includes by turnover with 50+ employees', () => {
    const company = { employeeCount: 60, annualRevenueEur: 12_000_000 } as CompanyProfile;
    expect(isCsrdInScope(company)).toBe(true);
  });

  it('includes CSRD for the larger profile', () => {
    const large = answerAll({
      company: {
        ...(answerAll().company as CompanyProfile),
        legalName: 'Meridian Manufacturing GmbH',
        employeeCount: 400,
        annualRevenueEur: 180_000_000,
      } as CompanyProfile,
    });
    expect(inferFrameworks(large)).toContain('csrd');
    expect(inferFrameworks(answerAll())).not.toContain('csrd');
  });
});

describe('gap analysis', () => {
  it('reports no gaps for a complete answer', () => {
    expect(findGaps(answerAll())).toEqual([]);
  });

  it('flags a high-risk system with no human oversight as a blocker', () => {
    const gaps = findGaps(
      answerAll({
        aiSystem: { ...(answerAll().aiSystem as AiSystemProfile), riskClass: 'high', humanOversightMeasures: [] },
      }),
    );
    const oversight = gaps.find((g) => g.id === 'ai-act/human-oversight');
    expect(oversight?.severity).toBe('blocker');
  });

  it('flags automated decision-making with legal effect', () => {
    const gaps = findGaps(
      answerAll({
        aiSystem: { ...(answerAll().aiSystem as AiSystemProfile), automatedDecisionMaking: true },
      }),
    );
    expect(gaps.map((g) => g.id)).toContain('gdpr/automated-decisions');
  });

  it('flags special-category data on consent with no consent mechanism', () => {
    const gaps = findGaps(
      answerAll({
        aiSystem: {
          ...(answerAll().aiSystem as AiSystemProfile),
          processesSpecialCategory: true,
          lawfulnessBasis: ['consent'],
          consentMechanism: undefined,
        },
      }),
    );
    expect(gaps.map((g) => g.id)).toContain('gdpr/special-category-consent');
  });

  it('flags CSRD gaps when in scope', () => {
    const inScope = answerAll({
      company: {
        ...(answerAll().company as CompanyProfile),
        employeeCount: 400,
        annualRevenueEur: 180_000_000,
      } as CompanyProfile,
      notes: {},
    });
    const gaps = findGaps(inScope);
    expect(gaps.map((g) => g.id)).toContain('csrd/materiality');
  });

  it('sorts blockers first', () => {
    const high = answerAll({
      aiSystem: {
        ...(answerAll().aiSystem as AiSystemProfile),
        riskClass: 'high',
        humanOversightMeasures: [],
        accuracyMetrics: undefined,
        conformityAssessmentDone: false,
      } as AiSystemProfile,
    });
    const sorted = sortGaps(findGaps(high));
    expect(sorted[0]?.severity).toBe('blocker');
  });

  it('scores a complete answer at 100', () => {
    expect(complianceScore(findGaps(answerAll()))).toBe(100);
  });
});

describe('document generation', () => {
  const answer = answerAll();
  const result = generate(answer);

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
  });


  it('marks unresolved values visibly rather than leaving a blank', () => {
    const partial = generate(
      answerAll({
        aiSystem: {
          ...(answerAll().aiSystem as AiSystemProfile),
          riskClass: 'high',
          humanOversightMeasures: [],
        },
      }),
    );
    const annex = partial.documents.find((d) => d.id === 'eu-ai-act/annex-iv')!;
    expect(annex.content).toContain('NOT PROVIDED');
    expect(annex.content).toContain('Gaps in this document');
  });

  it('generates CSRD documents for an in-scope company', () => {
    const csrd = generate(
      answerAll({
        company: {
          ...(answerAll().company as CompanyProfile),
          legalName: 'Meridian Manufacturing GmbH',
          employeeCount: 400,
          annualRevenueEur: 180_000_000,
        } as CompanyProfile,
        notes: { csrdMateriality: 'Climate and data privacy are material.', ghgScope1: '120 tCO2e', ghgScope2: '410 tCO2e' },
      }),
    );
    expect(csrd.frameworks).toContain('csrd');
    const materiality = csrd.documents.find((d) => d.id === 'csrd/materiality')!;
    expect(materiality.content).toContain('Climate and data privacy are material.');
  });

  it('ships every declared template', () => {
    const files = listTemplateFiles();
    for (const framework of ['eu-ai-act', 'gdpr', 'csrd', 'nis2', 'soc2']) {
      expect(files.some((f) => f.startsWith(framework)), framework).toBe(true);
    }
  });
});

describe('export bundles', () => {
  it('produces a DOCX that is a valid zip', () => {
    const result = generate(answerAll());
    const manifest = buildManifest(answerAll(), result);
    const bundle = toDocxBundle(result, manifest);
    const bytes = bundle.files[0]!.content as Uint8Array;
    expect(bytes[0]).toBe(0x50); // PK
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('writes a valid ZIP for an arbitrary entry', () => {
    const zip = zipSync([{ name: 'a.txt', data: 'hello' }]);
    expect(zip[0]).toBe(0x50);
    expect(zip.length).toBeGreaterThan(100);
  });

  it('carries the disclaimer everywhere', () => {
    const result = generate(answerAll());
    const manifest = buildManifest(answerAll(), result);
    expect(manifest.disclaimer).toContain('not legal advice');
  });
});

describe('codebase scan', () => {
  it('finds personal data in logs', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src/signup.ts'),
      "export function logSignup(email: string, password: string) {\n  console.log('signup', { email, password });\n}\n",
      'utf8',
    );
    const result = await scanForCompliance(dir);
    expect(result.findings.map((f) => f.id)).toContain('compliance/pii-in-logs');
  });

  it('reports nothing for a clean tree', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const add = (a: number, b: number): number => a + b;\n', 'utf8');
    const result = await scanForCompliance(dir);
    expect(result.findings).toHaveLength(0);
  });
});

