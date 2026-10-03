/**
 * The compliance questionnaire and its answers.
 *
 * This is the input to every generated document. It is deliberately structured
 * around what a regulator asks, not around what a tool can measure:
 *
 *  - EU AI Act wants a risk classification, a data-governance account, human
 *    oversight measures, and an accuracy/robustness claim.
 *  - GDPR wants a lawful basis, a data-category inventory, retention periods
 *    and a data-subject-rights process.
 *  - CSRD wants a materiality assessment and emissions figures.
 *
 * Answers are typed, not free text, wherever a regulator would want a defined
 * answer. `freeText` exists for narrative sections and is marked as such in
 * every generated document, because a template filled with "TBD" is worse than
 * no template: it looks complete.
 */

export type Jurisdiction = 'EU' | 'UK' | 'US-CA' | 'BR' | 'PE' | 'OTHER';

export type AiRiskClass = 'minimal' | 'limited' | 'high' | 'unacceptable';

export type SystemRole = 'provider' | 'deployer' | 'both';

export type LawfulBasis =
  | 'consent'
  | 'contract'
  | 'legal-obligation'
  | 'vital-interests'
  | 'public-task'
  | 'legitimate-interests';

export type DataCategory =
  | 'identity'
  | 'contact'
  | 'financial'
  | 'health'
  | 'biometric'
  | 'location'
  | 'behavioural'
  | 'communications'
  | 'employment'
  | 'special-category-other';

export interface CompanyProfile {
  legalName: string;
  tradingName?: string;
  registrationNumber: string;
  jurisdiction: Jurisdiction;
  /** Country of the main establishment. */
  country: string;
  /** Two-letter code, ISO 3166-1. */
  countryCode: string;
  sector: string;
  employeeCount: number;
  annualRevenueEur: number;
  /** Is turnover or headcount above the CSRD threshold (250 employees, or 50M EUR with >250k balance sheet)? */
  csrdInScope?: boolean;
  contactEmail: string;
  privacyEmail?: string;
  securityContact?: string;
  dpoName?: string;
  dpoEmail?: string;
}

export interface AiSystemProfile {
  name: string;
  purpose: string;
  /** Plain-language description of what it does, for the public-facing summary. */
  description: string;
  role: SystemRole;
  riskClass: AiRiskClass;
  /** Why the risk class was chosen. Required for high-risk. */
  riskRationale?: string;
  /** Intended purpose, in the words the Act uses. */
  intendedPurpose: string;

  /** Where it is used: workplace, education, essential services, etc. */
  deploymentContexts: string[];
  usersAffected: string[];

  /** Providers the system depends on. */
  modelProviders: string[];
  models: string[];
  /** Does the system use a general-purpose AI model (GPAI)? */
  usesGpai: boolean;
  gpaiModelName?: string;
  /** Is the GPAI model used in a way that triggers the systemic-risk threshold? */
  gpaiSystemicRisk?: boolean;

  automatedDecisionMaking: boolean;
  /** Human review of decisions. Required by Article 14 for high-risk. */
  humanOversightMeasures: string[];
  humanOversightResponsible?: string;

  /** Input data categories processed. */
  dataCategories: DataCategory[];
  /** Special category (Article 9) data. */
  processesSpecialCategory: boolean;
  lawfulnessBasis: LawfulBasis[];
  /** Consent, where consent is the basis. */
  consentMechanism?: string;
  dataProvenance: string;
  dataRetentionPeriod?: string;
  anonymisationOrPseudonymisation?: string;

  /** Accuracy, robustness and cybersecurity. */
  accuracyMetrics?: string;
  robustnessMeasures: string[];
  cybersecurityMeasures: string[];
  /** Evaluated against an eval set? */
  evaluationApproach?: string;

  /** Logging and monitoring. */
  loggingEnabled: boolean;
  loggingDetail: string;
  retentionOfLogs?: string;
  humanOversightOfLogs?: string;

  /** Post-market monitoring. */
  postMarketMonitoringPlan?: string;
  incidentResponseProcess?: string;
  conformityAssessmentDone?: boolean;
  ceMarkingObtained?: boolean;
  notifiedBodyEngaged?: boolean;
  registrationInEuDatabase?: boolean;

  /** Fairness. */
  biasAssessmentDone?: boolean;
  biasAssessmentMethod?: string;

  /** Free-text narrative used by several templates. */
  riskManagementApproach?: string;
  complaintsProcess?: string;
  dataProtectionImpactAssessment?: boolean;
  dpoConsulted?: boolean;
}

export interface ComplianceAnswer {
  company: CompanyProfile;
  aiSystem: AiSystemProfile;
  /** Frameworks to generate. Defaults to the ones the answers imply. */
  frameworks: Framework[];
  /** Answers given outside the questionnaire, for narrative sections. */
  notes?: Record<string, string>;
  completedAt: string;
  /** Version of the questionnaire, for regeneration diffs. */
  version: 1;
}

export type Framework = 'eu-ai-act' | 'gdpr' | 'csrd' | 'nis2' | 'soc2';

export const ALL_FRAMEWORKS: Framework[] = ['eu-ai-act', 'gdpr', 'csrd', 'nis2', 'soc2'];

/**
 * Which frameworks the answers imply.
 *
 * Deriving this rather than asking is the right default: an SME that runs an AI
 * system in the EU needs the AI Act pack and the GDPR pack whether or not they
 * know it, and CSRD depends on a threshold most people cannot recall.
 */
export function inferFrameworks(answer: ComplianceAnswer): Framework[] {
  const out = new Set<Framework>();
  const eu = answer.company.jurisdiction === 'EU' || answer.aiSystem.deploymentContexts.length > 0;

  if (eu) {
    out.add('eu-ai-act');
    out.add('gdpr');
  }
  if (answer.company.csrdInScope ?? isCsrdInScope(answer.company)) out.add('csrd');
  // NIS2 applies to essential and important entities above the size threshold.
  if (eu && answer.company.annualRevenueEur > 10_000_000 && answer.company.employeeCount > 50) out.add('nis2');
  if (answer.company.jurisdiction === 'US-CA' || answer.company.jurisdiction === 'UK') out.add('soc2');
  return [...out];
}

/**
 * CSRD scope, from the actual thresholds.
 *
 * The directive applies to companies over 250 employees, or over 50 employees
 * with more than EUR 10m turnover and more than EUR 25m balance sheet total.
 * We approximate the balance-sheet test using revenue, and flag that we did.
 */
export function isCsrdInScope(company: CompanyProfile): boolean {
  if (company.employeeCount >= 250) return true;
  if (company.employeeCount >= 50 && company.annualRevenueEur >= 10_000_000) return true;
  if (company.employeeCount >= 10 && company.annualRevenueEur >= 50_000_000) return true;
  return false;
}

/** Documentation the EU AI Act requires for a high-risk system. */
export const REQUIRED_AI_ACT_DOCUMENTS = [
  { id: 'annex-iv', name: 'Technical Documentation (Annex IV)', article: 'Article 11, Annex IV' },
  { id: 'risk-management', name: 'Risk Management System', article: 'Article 9' },
  { id: 'data-governance', name: 'Data Governance', article: 'Article 10' },
  { id: 'technical-design', name: 'Technical Design and Architecture', article: 'Annex IV.1(d), (f)' },
  { id: 'human-oversight', name: 'Human Oversight Measures', article: 'Article 14, Annex IV.1(d)' },
  { id: 'accuracy-robustness', name: 'Accuracy, Robustness and Cybersecurity', article: 'Article 15, Annex IV.1(f)' },
  { id: 'post-market', name: 'Post-Market Monitoring Plan', article: 'Article 72, Annex IV.1(i)' },
  { id: 'conformity', name: 'Declaration of Conformity', article: 'Article 17, Annex V' },
  { id: 'registration', name: 'EU Database Registration', article: 'Article 49' },
] as const;

export const REQUIRED_GDPR_DOCUMENTS = [
  { id: 'ropa', name: 'Record of Processing Activities (ROPA)', article: 'Article 30' },
  { id: 'dpia', name: 'Data Protection Impact Assessment (DPIA)', article: 'Article 35' },
  { id: 'privacy-notice', name: 'Privacy Notice', article: 'Article 13, 14' },
  { id: 'rights-process', name: 'Data Subject Rights Procedure', article: 'Article 12, 15-22' },
  { id: 'processing-register', name: 'Lawful Basis Register', article: 'Article 6' },
] as const;

export const REQUIRED_CSRD_DOCUMENTS = [
  { id: 'materiality', name: 'Double Materiality Assessment', article: 'ESRS 2 IRO-1, ORO-1' },
  { id: 'ghg-worksheet', name: 'GHG Emissions Calculation Worksheet', article: 'ESRS E1' },
  { id: 'data-collection', name: 'Sustainability Data Collection Template', article: 'ESRS 2, Appendix B' },
  { id: 'climate-transition', name: 'Climate Transition Plan', article: 'ESRS E1' },
] as const;

/** Gaps in the answers, each with what is missing and why it matters. */
export interface Gap {
  id: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  message: string;
  /** What a regulator would ask. */
  why: string;
  /** What to do about it. */
  action: string;
}

/**
 * Find what is missing before generating.
 *
 * We surface gaps rather than silently generating a document full of blanks: an
 * incomplete Annex IV is worse than no Annex IV, because it signals
 * non-compliance without disclosing it. Every generated document carries its
 * gap list into the output.
 */
export function findGaps(answer: ComplianceAnswer): Gap[] {
  const gaps: Gap[] = [];
  const { aiSystem: ai, company } = answer;
  const push = (gap: Gap): void => {
    gaps.push(gap);
  };

  if (!ai.riskRationale && (ai.riskClass === 'high' || ai.riskClass === 'limited')) {
    push({
      id: 'ai-act/risk-rationale',
      severity: ai.riskClass === 'high' ? 'blocker' : 'high',
      message: 'No rationale for the risk classification',
      why: 'Article 6 requires a documented classification. An auditor will ask how the class was reached.',
      action: 'Write one paragraph: what the system does, who it affects, and why that makes it high (or limited) risk.',
    });
  }

  if (ai.riskClass === 'high') {
    if (ai.humanOversightMeasures.length === 0) {
      push({
        id: 'ai-act/human-oversight',
        severity: 'blocker',
        message: 'High-risk system with no human oversight measures',
        why: 'Article 14 requires effective human oversight. Without it the system does not comply.',
        action: 'Describe who can override, how they are notified, and what stops the system acting when nobody is watching.',
      });
    }
    if (ai.accuracyMetrics === undefined || ai.accuracyMetrics.trim() === '') {
      push({
        id: 'ai-act/accuracy',
        severity: 'blocker',
        message: 'High-risk system with no accuracy metrics',
        why: 'Article 15 requires declared accuracy, robustness and cybersecurity measures.',
        action: 'Report the metric you already track: precision/recall on your eval set, error rate, or human-agreement rate.',
      });
    }
    if (ai.conformityAssessmentDone !== true) {
      push({
        id: 'ai-act/conformity',
        severity: 'blocker',
        message: 'Conformity assessment not completed',
        why: 'High-risk AI needs a conformity assessment, CE marking and, for some use cases, a notified body.',
        action: 'Run the internal control-based assessment, then apply for CE marking. Budget several weeks.',
      });
    }
    if (ai.registrationInEuDatabase !== true) {
      push({
        id: 'ai-act/registration',
        severity: 'high',
        message: 'Not registered in the EU database',
        why: 'Article 49 requires registration before placing a high-risk system on the market.',
        action: 'Register via the single EU portal. Takes about two weeks; do it before launch.',
      });
    }
    if (!ai.evaluationApproach) {
      push({
        id: 'ai-act/evals',
        severity: 'high',
        message: 'No evaluation approach documented',
        why: 'You cannot claim accuracy you have not measured.',
        action: 'Describe the eval set: how many cases, what they cover, and what pass rate you require.',
      });
    }
  }

  if (ai.processesSpecialCategory && ai.lawfulnessBasis.includes('consent')) {
    if (!ai.consentMechanism) {
      push({
        id: 'gdpr/special-category-consent',
        severity: 'blocker',
        message: 'Special category data processed on consent with no consent mechanism',
        why: 'Article 9 requires explicit consent, distinct from any other consent.',
        action: 'Implement explicit opt-in for special category data, separately collected and separately withdrawable.',
      });
    }
  }

  if (ai.dataCategories.length === 0) {
    push({
      id: 'gdpr/no-data-inventory',
      severity: 'high',
      message: 'No data categories declared',
      why: 'Article 30 requires a record of the categories of personal data processed.',
      action: 'List every category you process, including inferred data such as scores and classifications.',
    });
  }

  if (!ai.dataRetentionPeriod) {
    push({
      id: 'gdpr/retention',
      severity: 'high',
      message: 'No retention period',
      why: 'Article 5(1)(e) requires storage limitation. Keeping everything "just in case" is non-compliant.',
      action: 'Set a period per data category and implement deletion. Start with the shortest defensible period.',
    });
  }

  if (ai.automatedDecisionMaking) {
    push({
      id: 'gdpr/automated-decisions',
      severity: 'blocker',
      message: 'Automated decision-making with significant effect on people',
      why: 'Article 22 requires human intervention and the ability to contest the decision.',
      action: 'Provide a route to human review and a way to contest. Document the review criteria.',
    });
  }

  if (company.csrdInScope ?? isCsrdInScope(company)) {
    if (!answer.notes?.csrdMateriality) {
      push({
        id: 'csrd/materiality',
        severity: 'high',
        message: 'CSRD in scope but no materiality assessment',
        why: 'ESRS 2 requires both an impact and a financial materiality assessment, reported together.',
        action: 'Work through the double materiality worksheet: list impacts inside and outside, and financial effects.',
      });
    }
    if (!answer.notes?.ghgScope1 || !answer.notes?.ghgScope2) {
      push({
        id: 'csrd/emissions',
        severity: 'high',
        message: 'CSRD in scope but no Scope 1 or Scope 2 emissions',
        why: 'ESRS E1 requires gross Scope 1, Scope 2 and material Scope 3 emissions.',
        action: 'Start with electricity and fuel. Rough numbers with a stated method beat no numbers.',
      });
    }
  }

  if (answer.aiSystem.gpaiSystemicRisk && !ai.conformityAssessmentDone) {
    push({
      id: 'ai-act/gpai-safety',
      severity: 'high',
      message: 'Systemic-risk GPAI integrated without a safety package',
      why: 'Providers of systemic-risk GPAI need model evaluation and adversarial testing documentation.',
      action: 'Request the safety package from your model provider; you inherit its obligations downstream.',
    });
  }

  if (!ai.dpoConsulted && ai.processesSpecialCategory) {
    push({
      id: 'gdpr/dpo',
      severity: 'medium',
      message: 'Special category data processed without DPO consultation',
      why: 'Article 35(2) requires prior consultation of the data protection officer for high-risk DPIAs.',
      action: 'If you have a DPO, consult them before going live. If you do not, document why not.',
    });
  }

  if (!ai.complaintsProcess) {
    push({
      id: 'ai-act/complaints',
      severity: 'medium',
      message: 'No complaints process',
      why: 'Deployers of high-risk AI must provide a complaints mechanism and inform the provider.',
      action: 'Add a complaints route for AI outputs and a log of what you did with each one.',
    });
  }

  return gaps;
}

/**
 * Gap severity, ordered worst first.
 *
 * A `blocker` gap means the document is not merely incomplete: shipping it as-is
 * would misrepresent the state of compliance.
 */
export function sortGaps(gaps: readonly Gap[]): Gap[] {
  const rank = { blocker: 0, high: 1, medium: 2, low: 3 } as const;
  return [...gaps].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * A readiness score for a compliance pack.
 *
 * Weighted by gap severity rather than counting gaps, because one missing
 * conformity assessment matters far more than three missing narrative
 * sections. The score is a conversation starter with an auditor, not a
 * certification: we say so in the generated output too.
 */
export function complianceScore(gaps: readonly Gap[]): number {
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