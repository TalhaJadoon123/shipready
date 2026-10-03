import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComplianceAnswer, Framework, Gap } from './types.js';
import { findGaps, inferFrameworks, sortGaps } from './types.js';

/**
 * Document generation.
 *
 * Templates are real files under `templates/` rather than string concatenation,
 * for the same reason the autofix templates are: a generated compliance
 * document is read by lawyers and auditors, and it has to read as prose, with
 * section numbering and placeholders that are obvious when unresolved.
 *
 * `<<NAME>>` is the placeholder syntax throughout. Every placeholder has a
 * resolver; the ones that cannot be answered from the questionnaire render as a
 * clearly-marked `NOT PROVIDED` line rather than an empty space, because a
 * blank in a regulatory document reads as an omission the author chose.
 */

/**
 * Placeholders the author fills in by hand.
 *
 * These are narrative and operational values a questionnaire cannot know: a
 * supervisory authority's name, a signatory, a threshold, a review cadence.
 * They are deliberately left as marked `NOT PROVIDED` rather than guessed,
 * because a compliance document with a plausible-looking fabricated figure in
 * it is worse than one with an obvious blank.
 *
 * Anything NOT in this set that fails to resolve is a bug in the resolver and
 * is reported through `GeneratedDocument.unresolved`.
 */
export const AUTHOR_PLACEHOLDERS: ReadonlySet<string> = new Set([
  // Thresholds, cadences and owners
  'OVERSIGHT_REVIEW_PERIOD',
  'EVALUATION_FREQUENCY',
  'EVALUATION_OWNER',
  'LEGAL_REVIEW_PERIOD',
  'PLAN_REVIEW_PERIOD',
  'DPIA_REVIEW_PERIOD',
  'RIGHTS_LOG_RETENTION',
  'LIMITATIONS',
  'LIKELIHOOD',
  'SEVERITY',
  'CSIRT_CONTACT',
  'DATA_OWNER',
  'MATERIALITY_APPROVER',
  'MATERIALITY_APPROVED_DATE',
  'ASSESSMENT_PERIOD',
  'VALUE_CHAIN_SCOPE',
  'REPORTING_PERIOD',
  'SIGNIFICANT_INCIDENT_THRESHOLDS',

  // Materiality matrix cells
  'THRESHOLD_CLIMATE',
  'MATERIAL_CLIMATE',
  'THRESHOLD_ENERGY',
  'MATERIAL_ENERGY',
  'THRESHOLD_WATER',
  'MATERIAL_WATER',
  'THRESHOLD_WASTE',
  'MATERIAL_WASTE',
  'THRESHOLD_PRIVACY',
  'MATERIAL_PRIVACY',
  'THRESHOLD_AI',
  'MATERIAL_AI',
  'THRESHOLD_WORKFORCE',
  'MATERIAL_WORKFORCE',
  'THRESHOLD_DIVERSITY',
  'MATERIAL_DIVERSITY',
  'CORRUPTION_CONTEXT',
  'THRESHOLD_CORRUPTION',
  'MATERIAL_CORRUPTION',
  'MATERIAL_TOPICS',
  'UPSTREAM_ASSESSMENT',
  'DOWNSTREAM_ASSESSMENT',

  // Financial materiality cells
  'ENERGY_FINANCIAL',
  'ENERGY_FINANCIAL_MET',
  'MATERIAL_ENERGY_FIN',
  'CARBON_FINANCIAL',
  'CARBON_FINANCIAL_MET',
  'MATERIAL_CARBON_FIN',
  'RESILIENCE_FINANCIAL',
  'RESILIENCE_FINANCIAL_MET',
  'MATERIAL_RESILIENCE_FIN',
  'PRIVACY_FINANCIAL',
  'PRIVACY_FINANCIAL_MET',
  'MATERIAL_PRIVACY_FIN',
  'SUPPLY_FINANCIAL',
  'SUPPLY_FINANCIAL_MET',
  'MATERIAL_SUPPLY_FIN',
  'TALENT_FINANCIAL',
  'TALENT_FINANCIAL_MET',
  'MATERIAL_TALENT_FIN',

  // GHG worksheet
  'GWP_BASIS',
  'BASE_YEAR',
  'BASE_YEAR_TONNES',
  'CONSOLIDATION_APPROACH',
  'OPERATIONAL_BOUNDARY',
  'GAS_ACTIVITY',
  'GAS_FACTOR',
  'GAS_TCO2E',
  'GAS_DATA_QUALITY',
  'GAS_ESTIMATION_METHOD',
  'VEHICLE_ACTIVITY',
  'VEHICLE_FACTOR',
  'VEHICLE_TCO2E',
  'REFRIGERANT_KG',
  'REFRIGERANT_GWP',
  'REFRIGERANT_TCO2E',
  'OFFICE_ELEC_ACTIVITY',
  'OFFICE_ELEC_REGION',
  'OFFICE_ELEC_FACTOR',
  'OFFICE_ELEC_TCO2E',
  'HOSTING_ELEC_ACTIVITY',
  'HOSTING_ELEC_REGION',
  'HOSTING_ELEC_FACTOR',
  'HOSTING_ELEC_TCO2E',
  'OFFICE_INSTRUMENT',
  'OFFICE_INSTRUMENT_PCT',
  'OFFICE_MB_TCO2E',
  'HOSTING_INSTRUMENT',
  'HOSTING_INSTRUMENT_PCT',
  'HOSTING_MB_TCO2E',
  'S3_1_MATERIAL',
  'S3_1_QUALITY',
  'S3_1_TCO2E',
  'S3_2_MATERIAL',
  'S3_2_QUALITY',
  'S3_2_TCO2E',
  'S3_3_MATERIAL',
  'S3_3_QUALITY',
  'S3_3_TCO2E',
  'S3_4_MATERIAL',
  'S3_5_MATERIAL',
  'S3_5_QUALITY',
  'S3_5_TCO2E',
  'S3_6_MATERIAL',
  'S3_6_QUALITY',
  'S3_6_TCO2E',
  'S3_7_MATERIAL',
  'S3_7_QUALITY',
  'S3_7_TCO2E',
  'S3_8_MATERIAL',
  'S3_8_QUALITY',
  'S3_8_TCO2E',
  'S3_13_MATERIAL',
  'S3_13_METHOD',
  'S3_13_QUALITY',
  'S3_13_TCO2E',
  'SCOPE2_MARKET_TOTAL',
  'TOTAL_MARKET',
  'E1_1_SOURCE',
  'Q1_PRIMARY',
  'Q1_SPECIFIC',
  'Q1_ESTIMATED',
  'Q2_PRIMARY',
  'Q2_SPECIFIC',
  'Q2_ESTIMATED',
  'Q3_PRIMARY',
  'Q3_SPECIFIC',
  'Q3_ESTIMATED',
  'CHANGE_VS_BASE_YEAR',
  'AI_EMISSIONS_METHOD',
  'TRANSITION_ACTION',
  'TRANSITION_LEVER',
  'TRANSITION_REDUCTION',
  'TRANSITION_COST',
  'TRANSITION_WHEN',

  // Declaration of conformity and signature
  'EU_REPRESENTATIVE',
  'DEPLOYMENT_DATE',
  'ADDITIONAL_LEGISLATION',
  'NON_APPLICABLE_STATEMENTS',
  'CONFORMITY_METHOD',
  'CONFORMITY_NOTE',
  'HARMONISED_STANDARD',
  'APPLIED',
  'EU_DATABASE_REFERENCE',
  'SIGNATORY_NAME',
  'SIGNATORY_TITLE',
  'SIGNATURE_DATE',

  // GDPR operational details
  'TRANSFER_COUNTRIES',
  'AI_ACT_HUMAN_OVERSIGHT',
  'BILLING_RETENTION',
  'OTHER_PROCESSING_NOTE',
  'PRIVACY_URL',
  'COMPANY_POSTAL_ADDRESS',
  'ERASURE_NOTE',
  'SUPERVISORY_AUTHORITY',
  'LEAD_AUTHORITY',
  'DPIA_STATUS',
  'DATA_VOLUME',
  'ALTERNATIVE_REASON',
  'AI_ACT_HIGH_RISK_TRIGGER',
  'ARTICLE9_CONDITION',
  'DPO_OPINION',
  'SUPERVISORY_CONSULTATION',

  // NIS2
  'SECURITY_POLICIES',
  'BUSINESS_CONTINUITY',
  'EFFECTIVENESS_ASSESSMENT',
  'SECURITY_TRAINING',
  'CRYPTOGRAPHY_POLICY',
  'ACCESS_MANAGEMENT',
  'MFA_POLICY',

  // SOC 2
  'ACCESS_REVIEW_PERIOD',
  'MFA_STATUS',
  'OFFBOARDING_SLA',
  'BOUNDARY_PROTECTION',
  'MALWARE_PROTECTION',
  'CHANGE_DETECTION',
  'MONITORING',
  'EVENT_EVALUATION',
  'DETECT_TARGET',
  'TRIAGE_TARGET',
  'CONTAIN_TARGET',
  'RECOVER_TARGET',
  'PIR_TARGET',
  'RECOVERY',
  'EMERGENCY_CHANGE_PROCESS',
  'PROVIDER_ASSURANCE',
  'ACCESS_REVIEW_RETENTION',
  'CHANGE_RETENTION',
  'INCIDENT_RETENTION',
  'VULN_RETENTION',
  'PENTEST_RETENTION',
  'BACKUP_TEST_RETENTION',
]);

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, '..', 'templates');

/**
 * What an unanswered value renders as.
 *
 * A regulatory document has two kinds of blank, and only one of them is honest:
 * a blank that means "we were asked and the answer is empty" is fine; a blank
 * that means "nobody answered" looks identical on the page. So every
 * unresolved value renders as a visible marker.
 */
const NOT_PROVIDED = '**NOT PROVIDED** (see gap report)';

export interface GeneratedDocument {
  id: string;
  framework: Framework;
  title: string;
  /** Article or standard the document satisfies. */
  reference: string;
  /** Markdown body. */
  content: string;
  /** Gaps that affect this document specifically. */
  gaps: Gap[];
  /** Placeholders that could not be resolved from the answers. */
  unresolved: string[];
}

export interface GenerateOptions {
  /** Restrict generation to these frameworks. Defaults to the inferred set. */
  frameworks?: Framework[];
  /** Include the gap report inside each document. */
  includeGapReport?: boolean;
  /** Extra narrative answers, keyed by placeholder name. */
  notes?: Record<string, string>;
}

export interface GenerateResult {
  documents: GeneratedDocument[];
  frameworks: Framework[];
  gaps: Gap[];
  score: number;
  generatedAt: string;
}

export function generate(answer: ComplianceAnswer, options: GenerateOptions = {}): GenerateResult {
  const frameworks = options.frameworks ?? inferFrameworks(answer);
  const gaps = sortGaps(findGaps(answer));
  const notes = { ...(answer.notes ?? {}), ...(options.notes ?? {}) };
  const includeGaps = options.includeGapReport ?? true;

  const documents: GeneratedDocument[] = [];
  for (const framework of frameworks) {
    for (const template of templatesFor(framework)) {
      const raw = readTemplate(template.file);
      const { text, unresolved } = substitute(raw, answer, gaps, notes);
      const body = includeGaps ? appendGapReport(text, gaps, template.gapPrefix) : text;
      documents.push({
        id: `${framework}/${template.id}`,
        framework,
        title: template.title,
        reference: template.reference,
        content: body.trimEnd() + '\n',
        gaps: gaps.filter((g) => g.id.startsWith(template.gapPrefix)),
        unresolved,
      });
    }
  }

  return {
    documents,
    frameworks,
    gaps,
    score: scoreFrom(gaps),
    generatedAt: new Date().toISOString(),
  };
}

interface TemplateSpec {
  file: string;
  id: string;
  title: string;
  reference: string;
  gapPrefix: string;
}

const TEMPLATES: Record<Framework, TemplateSpec[]> = {
  'eu-ai-act': [
    { file: 'eu-ai-act/annex-iv.tmpl.md', id: 'annex-iv', title: 'Technical Documentation (Annex IV)', reference: 'Regulation (EU) 2024/1689, Article 11 and Annex IV', gapPrefix: 'ai-act' },
    { file: 'eu-ai-act/risk-management.tmpl.md', id: 'risk-management', title: 'Risk Management System', reference: 'Article 9', gapPrefix: 'ai-act' },
    { file: 'eu-ai-act/human-oversight.tmpl.md', id: 'human-oversight', title: 'Human Oversight Measures', reference: 'Article 14', gapPrefix: 'ai-act/human-oversight' },
    { file: 'eu-ai-act/post-market.tmpl.md', id: 'post-market', title: 'Post-Market Monitoring Plan', reference: 'Article 72', gapPrefix: 'ai-act' },
    { file: 'eu-ai-act/conformity.tmpl.md', id: 'conformity', title: 'Declaration of Conformity', reference: 'Article 17, Annex V', gapPrefix: 'ai-act/conformity' },
  ],
  gdpr: [
    { file: 'gdpr/ropa.tmpl.md', id: 'ropa', title: 'Record of Processing Activities', reference: 'Article 30', gapPrefix: 'gdpr' },
    { file: 'gdpr/dpia.tmpl.md', id: 'dpia', title: 'Data Protection Impact Assessment', reference: 'Article 35', gapPrefix: 'gdpr' },
    { file: 'gdpr/rights.tmpl.md', id: 'rights', title: 'Data Subject Rights Procedure', reference: 'Articles 12, 15-22', gapPrefix: 'gdpr/retention' },
  ],
  csrd: [
    { file: 'csrd/materiality.tmpl.md', id: 'materiality', title: 'Double Materiality Assessment', reference: 'ESRS 2 IRO-1, ORO-1', gapPrefix: 'csrd' },
    { file: 'csrd/ghg-worksheet.tmpl.md', id: 'ghg-worksheet', title: 'GHG Emissions Calculation Worksheet', reference: 'ESRS E1', gapPrefix: 'csrd' },
    { file: 'csrd/data-collection.tmpl.md', id: 'data-collection', title: 'Sustainability Data Collection Template', reference: 'ESRS 2 Appendix B', gapPrefix: 'csrd' },
  ],
  nis2: [
    { file: 'nis2/cybersecurity.tmpl.md', id: 'cybersecurity', title: 'Cybersecurity Risk Management Statement', reference: 'Directive (EU) 2022/2555, Article 21', gapPrefix: 'nis2' },
  ],
  soc2: [
    { file: 'soc2/security-practices.tmpl.md', id: 'security-practices', title: 'Security Practices and Incident Response', reference: 'AICPA SOC 2 CC6, CC7', gapPrefix: 'soc2' },
  ],
};

function templatesFor(framework: Framework): TemplateSpec[] {
  return TEMPLATES[framework] ?? [];
}

function readTemplate(relative: string): string {
  const abs = join(TEMPLATE_DIR, relative);
  if (!existsSync(abs)) {
    throw new Error(
      `Compliance template not found: ${relative}. Templates ship in the package's templates/ directory.`,
    );
  }
  return readFileSync(abs, 'utf8');
}

/** Template files shipped, for the test that every declared template exists. */
export function listTemplateFiles(): string[] {
  if (!existsSync(TEMPLATE_DIR)) return [];
  const out: string[] = [];
  for (const framework of readdirSync(TEMPLATE_DIR)) {
    const dir = join(TEMPLATE_DIR, framework);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) out.push(`${framework}/${file}`);
  }
  return out.sort();
}

function substitute(
  template: string,
  answer: ComplianceAnswer,
  gaps: readonly Gap[],
  notes: Record<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const values = buildValues(answer, notes);

  const text = template.replace(/<<([A-Z0-9_]+)>>/g, (_match, key: string) => {
    const value = values[key];
    if (value !== undefined && value !== '') return value;
    // An author-filled placeholder is expected to be blank; anything else that
    // fails to resolve is a resolver bug and is reported.
    if (!AUTHOR_PLACEHOLDERS.has(key)) unresolved.push(key);
    // A visible marker rather than an empty string: a blank in a regulatory
    // document reads as an author choice.
    return NOT_PROVIDED;
  });

  void gaps;
  return { text, unresolved };
}

/**
 * Every placeholder the templates can reference.
 *
 * Kept in one map so an unanswered question produces one consistent label
 * everywhere, rather than "TBD" in one document and an empty cell in another.
 */
function buildValues(answer: ComplianceAnswer, notes: Record<string, string>): Record<string, string> {
  const { company: c, aiSystem: a } = answer;
  /**
   * Render a list.
   *
   * `undefined` means the questionnaire was never asked, which is different
   * from an empty array meaning the answer is genuinely "none of these". A
   * regulatory document that says "None declared" when the question was skipped
   * is asserting something nobody confirmed, so an unanswered list is marked the
   * same way every other missing value is.
   */
  const list = (items: readonly string[] | undefined, empty = 'None declared'): string => {
    if (items === undefined) return NOT_PROVIDED;
    return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : empty;
  };

  const basisLabel: Record<string, string> = {
    consent: 'Consent (Art. 6(1)(a))',
    contract: 'Performance of a contract (Art. 6(1)(b))',
    'legal-obligation': 'Legal obligation (Art. 6(1)(c))',
    'vital-interests': 'Vital interests (Art. 6(1)(d))',
    'public-task': 'Public task (Art. 6(1)(e))',
    'legitimate-interests': 'Legitimate interests (Art. 6(1)(f))',
  };

  const dataCategoryLabel: Record<string, string> = {
    identity: 'Identity data (name, ID numbers)',
    contact: 'Contact data (email, phone, address)',
    financial: 'Financial data (payment details, account numbers)',
    health: 'Health data',
    biometric: 'Biometric data',
    location: 'Location data',
    behavioural: 'Behavioural data (usage, interactions, preferences)',
    communications: 'Communications (messages, emails)',
    employment: 'Employment data',
    'special-category-other': 'Other special category data (Art. 9)',
  };

  return {
    // --- Document metadata ---
    DOCUMENT_DATE: new Date().toISOString().slice(0, 10),
    AI_VERSION: '1.0.0',

    // --- Company ---
    COMPANY_LEGAL_NAME: c.legalName,
    COMPANY_TRADING_NAME: c.tradingName ?? c.legalName,
    COMPANY_REGISTRATION: c.registrationNumber,
    COMPANY_COUNTRY: c.country,
    COMPANY_COUNTRY_CODE: c.countryCode,
    JURISDICTION: c.jurisdiction,
    SECTOR: c.sector,
    EMPLOYEE_COUNT: String(c.employeeCount),
    ANNUAL_REVENUE: `EUR ${c.annualRevenueEur.toLocaleString('en-GB')}`,
    CONTACT_EMAIL: c.contactEmail,
    PRIVACY_EMAIL: c.privacyEmail ?? c.contactEmail,
    SECURITY_CONTACT: c.securityContact ?? c.contactEmail,
    DPO_NAME: c.dpoName ?? '<<NOT_APPOINTED>>',
    DPO_EMAIL: c.dpoEmail ?? c.contactEmail,

    // --- AI system ---
    AI_NAME: a.name,
    AI_PURPOSE: a.purpose,
    AI_DESCRIPTION: a.description,
    INTENDED_PURPOSE: a.intendedPurpose,
    AI_ROLE: a.role === 'provider' ? 'Provider' : a.role === 'deployer' ? 'Deployer' : 'Provider and deployer',
    RISK_CLASS: riskLabel(a.riskClass),
    RISK_CLASS_RAW: a.riskClass,
    RISK_RATIONALE: a.riskRationale ?? NOT_PROVIDED,
    DEPLOYMENT_CONTEXTS: list(a.deploymentContexts),
    USERS_AFFECTED: list(a.usersAffected),
    MODEL_PROVIDERS: list(a.modelProviders),
    MODELS: list(a.models),
    GPAI_MODEL: a.gpaiModelName ?? 'Not applicable',
    GPAI_SYSTEMIC_RISK: a.gpaiSystemicRisk ? 'Yes' : 'No',
    AUTOMATED_DECISIONS: a.automatedDecisionMaking
      ? 'Yes. Decisions are made without human intervention.'
      : 'No. A human reviews every decision.',
    HUMAN_OVERSIGHT_MEASURES: list(a.humanOversightMeasures),
    HUMAN_OVERSIGHT_RESPONSIBLE: a.humanOversightResponsible ?? NOT_PROVIDED,
    DATA_CATEGORIES: list(a.dataCategories.map((d) => dataCategoryLabel[d] ?? d)),
    SPECIAL_CATEGORY: a.processesSpecialCategory
      ? `Yes. Special category data under Article 9 is processed.${a.anonymisationOrPseudonymisation ? ` ${a.anonymisationOrPseudonymisation}` : ''}`
      : 'No.',
    LAWFUL_BASIS: list(a.lawfulnessBasis.map((b) => basisLabel[b] ?? b)),
    CONSENT_MECHANISM: a.consentMechanism ?? 'Not applicable (consent is not the basis).',
    DATA_PROVENANCE: a.dataProvenance,
    DATA_RETENTION: a.dataRetentionPeriod ?? NOT_PROVIDED,
    ANONYMISATION: a.anonymisationOrPseudonymisation ?? 'Not implemented.',
    ACCURACY_METRICS: a.accuracyMetrics ?? NOT_PROVIDED,
    ROBUSTNESS_MEASURES: list(a.robustnessMeasures),
    CYBERSECURITY_MEASURES: list(a.cybersecurityMeasures),
    EVALUATION_APPROACH: a.evaluationApproach ?? NOT_PROVIDED,
    LOGGING_ENABLED: a.loggingEnabled ? 'Yes' : 'No',
    LOGGING_DETAIL: a.loggingDetail,
    LOG_RETENTION: a.retentionOfLogs ?? 'Not defined.',
    LOG_HUMAN_OVERSIGHT: a.humanOversightOfLogs ?? 'Not defined.',
    POST_MARKET_PLAN: a.postMarketMonitoringPlan ?? NOT_PROVIDED,
    INCIDENT_RESPONSE: a.incidentResponseProcess ?? NOT_PROVIDED,
    CONFORMITY_DONE: a.conformityAssessmentDone ? 'Yes' : 'No',
    CE_MARKING: a.ceMarkingObtained ? 'Yes' : 'No',
    NOTIFIED_BODY: a.notifiedBodyEngaged ? 'Yes' : 'No',
    EU_DATABASE_REGISTRATION: a.registrationInEuDatabase ? 'Yes' : 'No',
    BIAS_ASSESSMENT: a.biasAssessmentDone
      ? `Yes.${a.biasAssessmentMethod ? ` ${a.biasAssessmentMethod}` : ''}`
      : 'No.',
    // Residual risk rows are a table the author fills in; an empty row beats a
    // fabricated risk score.
    ACCURACY_THRESHOLD: notes.accuracyThreshold ?? NOT_PROVIDED,
    ERROR_RATE_THRESHOLD: notes.errorRateThreshold ?? NOT_PROVIDED,
    LATENCY_THRESHOLD: notes.latencyThreshold ?? NOT_PROVIDED,
    COST_THRESHOLD: notes.costThreshold ?? NOT_PROVIDED,
    RESIDUAL_RISK_ONE: NOT_PROVIDED,
    RISK_MANAGEMENT_APPROACH: a.riskManagementApproach ?? NOT_PROVIDED,
    COMPLAINTS_PROCESS: a.complaintsProcess ?? NOT_PROVIDED,
    DPIA: a.dataProtectionImpactAssessment ? 'Completed' : 'Required but not completed',
    DPO_CONSULTED: a.dpoConsulted ? 'Yes' : 'No',

    // --- CSRD notes, all optional ---
    CSRD_MATERIALITY: notes.csrdMateriality ?? NOT_PROVIDED,
    CSRD_IMPACT_MATERIALITY: notes.csrdImpactMateriality ?? NOT_PROVIDED,
    CSRD_FINANCIAL_MATERIALITY: notes.csrdFinancialMateriality ?? NOT_PROVIDED,
    GHG_SCOPE1: notes.ghgScope1 ?? NOT_PROVIDED,
    SCOPE1_TOTAL: notes.ghgScope1 ?? NOT_PROVIDED,
    SCOPE2_LOCATION_TOTAL: notes.ghgScope2 ?? NOT_PROVIDED,
    SCOPE3_TOTAL: notes.ghgScope3 ?? 'Not yet assessed.',
    TOTAL_LOCATION: notes.ghgTotal ?? NOT_PROVIDED,
    GHG_SCOPE2: notes.ghgScope2 ?? NOT_PROVIDED,
    GHG_SCOPE3: notes.ghgScope3 ?? 'Not yet assessed.',
    GHG_METHOD: notes.ghgMethod ?? 'GHG Protocol, Corporate Standard, with secondary-market and location-based reporting.',
    GHG_BOUNDARY: notes.ghgBoundary ?? 'Operational control, equity share.',
    CLIMATE_TARGET: notes.climateTarget ?? 'No target set.',
    CLIMATE_TRANSITION_PLAN: notes.climateTransitionPlan ?? NOT_PROVIDED,
    SUSTAINABILITY_METRICS: notes.sustainabilityMetrics ?? NOT_PROVIDED,
    NIS2_ENTITY_TYPE: notes.nis2EntityType ?? 'Essential entity',
    NIS2_MANAGEMENT_BODIES: notes.nis2ManagementBodies ?? NOT_PROVIDED,
    NIS2_INCIDENT_HANDLING: notes.nis2IncidentHandling ?? NOT_PROVIDED,
    NIS2_SUPPLY_CHAIN: notes.nis2SupplyChain ?? 'Not assessed.',
    SOC2_CRITERIA: notes.soc2Criteria ?? 'CC6.1, CC6.6, CC7.1, CC7.2, CC8.1',
    SOC2_INCIDENT_PROCESS: notes.soc2IncidentProcess ?? NOT_PROVIDED,
    SOC2_CHANGE_MANAGEMENT: notes.soc2ChangeManagement ?? NOT_PROVIDED,
  };
}

function riskLabel(riskClass: string): string {
  switch (riskClass) {
    case 'minimal':
      return 'Minimal risk (Annex III does not apply; transparency obligations in Article 50 may still apply)';
    case 'limited':
      return 'Limited risk (transparency obligations under Article 50)';
    case 'high':
      return 'High risk (Annex III or Article 6(3))';
    case 'unacceptable':
      return 'Unacceptable risk (prohibited under Article 5)';
    default:
      return riskClass;
  }
}

/**
 * Append the gap report.
 *
 * Every generated document carries the gaps that affect it. A compliance pack
 * that hides its own holes is worse than no pack.
 */
function appendGapReport(body: string, gaps: readonly Gap[], prefix: string): string {
  const relevant = gaps.filter((g) => g.id.startsWith(prefix));
  if (relevant.length === 0) return body;

  const lines = [
    body.trimEnd(),
    '',
    '---',
    '',
    '## Gaps in this document',
    '',
    'The following items are **not yet documented**. Each one is a question a',
    'regulator, notified body or auditor can ask. Nothing here is a legal opinion.',
    '',
  ];

  for (const gap of relevant) {
    lines.push(`### ${gap.id}`);
    lines.push('');
    lines.push(`- **Status:** NOT PROVIDED — the section above is incomplete because of this.`);
    lines.push(`- **Severity:** ${gap.severity.toUpperCase()}`);
    lines.push(`- **Missing:** ${gap.message}`);
    lines.push(`- **Why it matters:** ${gap.why}`);
    lines.push(`- **What to do:** ${gap.action}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `Generated by ShipReady from a self-assessment. This document is a starting point for your compliance work, not legal advice, and not a conformity assessment. Verified by: ________________  Date: ____________`,
  );
  lines.push('');

  return lines.join('\n');
}

function scoreFrom(gaps: readonly Gap[]): number {
  const penalty = gaps.reduce((sum, gap) => {
    switch (gap.severity) {
      case 'blocker':
        return sum + 25;
      case 'high':
        return sum + 12;
      case 'medium':
        return sum + 5;
      default:
        return sum + 2;
    }
  }, 0);
  return Math.max(0, 100 - penalty);
}

/** Suggested filename for a generated document. */
export function filenameFor(document: GeneratedDocument): string {
  const slug = document.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `compliance/${document.framework}/${slug}.md`;
}
