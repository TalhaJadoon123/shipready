import type { AiRiskClass, AiSystemProfile, ComplianceAnswer, CompanyProfile, Framework, Jurisdiction } from './types.js';
import { ALL_FRAMEWORKS, inferFrameworks } from './types.js';

/**
 * The questionnaire.
 *
 * Ordered so that a person answering it stays in one mental mode: the company,
 * then the system's purpose, then its data, then its safeguards. Questions are
 * written the way a regulator asks them, not the way an engineer would
 * describe them, because the answer is going into a document that an auditor
 * reads.
 *
 * Every question carries `why`, and the CLI shows it. People answer honestly
 * when they understand why they are being asked, and skip questions they would
 * otherwise guess at.
 */
export interface Question {
  id: string;
  section: Section;
  prompt: string;
  /** Shown when the question is asked. The reason it is being asked. */
  why: string;
  type: 'text' | 'choice' | 'multichoice' | 'boolean' | 'number';
  choices?: string[];
  /** Optional, and the default. */
  optional?: boolean;
  /** Skip the question when this returns false. */
  when?: (answer: Partial<ComplianceAnswer>) => boolean;
  /** Map a raw answer onto the answer object. */
  assign: (answer: Partial<ComplianceAnswer>, value: string | string[] | boolean | number) => void;
}

export type Section = 'company' | 'purpose' | 'risk' | 'models' | 'data' | 'oversight' | 'safety' | 'operations';

const COMPANY = (key: keyof CompanyProfile, prompt: string, why: string, type: Question['type'] = 'text'): Question => ({
  id: `company.${key}`,
  section: 'company',
  prompt,
  why,
  type,
  assign: (answer, value) => {
    const company = (answer.company ??= {} as CompanyProfile);
    (company as unknown as Record<string, unknown>)[key] = value;
  },
});

const AI = (
  key: keyof AiSystemProfile,
  prompt: string,
  why: string,
  type: Question['type'] = 'text',
  extra: Partial<Question> = {},
): Question => ({
  id: `ai.${key}`,
  section: key === 'purpose' || key === 'intendedPurpose' || key === 'description' ? 'purpose' : 'safety',
  prompt,
  why,
  type,
  assign: (answer, value) => {
    const ai = (answer.aiSystem ??= {} as AiSystemProfile);
    (ai as unknown as Record<string, unknown>)[key] = value;
  },
  ...extra,
});

export const QUESTIONS: Question[] = [
  // --- Company -------------------------------------------------------------
  COMPANY('legalName', 'What is the registered legal name of the company?', 'Every generated document has to identify the legal entity, not the trading name.'),
  COMPANY('tradingName', 'Trading name (if different)', 'Used in customer-facing sections.', 'text'),
  COMPANY('registrationNumber', 'Company registration number', 'Identifies the entity in the jurisdiction of incorporation.'),
  {
    id: 'company.jurisdiction',
    section: 'company',
    prompt: 'Primary jurisdiction',
    why: 'Determines which regulations apply. EU, UK and US (California) are supported with different frameworks.',
    type: 'choice',
    choices: ['EU', 'UK', 'US-CA', 'BR', 'PE', 'OTHER'],
    assign: (answer, value) => {
      const company = (answer.company ??= {} as CompanyProfile);
      company.jurisdiction = String(value) as Jurisdiction;
    },
  },
  COMPANY('country', 'Country of main establishment', 'Used for retention periods and supervisory authorities, which differ by country.'),
  COMPANY('countryCode', 'ISO 3166-1 alpha-2 country code', 'For the EU database and transfer assessments.', 'text'),
  COMPANY('sector', 'Sector', 'Certain sectors have additional obligations under the AI Act and NIS2.'),
  COMPANY('employeeCount', 'Number of employees (FTE)', 'Determines CSRD scope and NIS2 classification.', 'number'),
  COMPANY('annualRevenueEur', 'Annual revenue in EUR', 'Determines CSRD scope.', 'number'),
  COMPANY('contactEmail', 'Compliance contact email', 'The address an auditor or supervisory authority will use.'),
  COMPANY('privacyEmail', 'Data protection contact email', 'For GDPR notices. Defaults to the compliance contact.', 'text'),
  {
    id: 'company.dpoName',
    section: 'company',
    prompt: 'Data Protection Officer name (or "none appointed")',
    why: 'Article 37 requires a DPO for certain controllers. State it plainly either way.',
    type: 'text',
    optional: true,
    assign: (answer, value) => {
      const company = (answer.company ??= {} as CompanyProfile);
      company.dpoName = String(value);
    },
  },

  // --- Purpose -------------------------------------------------------------
  AI('name', 'What is the AI system called?', 'The name used throughout the technical documentation.'),
  AI('intendedPurpose', 'What is the intended purpose, in one sentence?', 'Article 9 and Annex IV require a precise intended purpose. Vague wording here invalidates the conformity assessment.'),
  AI('description', 'Describe what it does, for a non-technical reader.', 'Deployers and affected people must be able to understand the system without reading the code.'),
  AI('purpose', 'What business problem does it solve?', 'Used in the risk management narrative.', 'text', { section: 'purpose' }),
  {
    id: 'ai.role',
    section: 'purpose',
    prompt: 'Your role under the AI Act',
    why: 'Provider and deployer have different obligations, and sometimes both apply to you.',
    type: 'choice',
    choices: ['provider', 'deployer', 'both'],
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.role = String(value) as AiSystemProfile['role'];
    },
  },
  AI(
    'deploymentContexts',
    'Where is it used? (e.g. workplace, education, essential services, emergency services)',
    'Annex III classification depends on the deployment context, not on the technology.',
    'multichoice',
    { section: 'risk', choices: ['workplace', 'education', 'essential-services', 'emergency-services', 'law-enforcement', 'migration', 'justice', 'consumer', 'internal-business'] },
  ),
  AI('usersAffected', 'Who is affected by its output?', 'Annex IV requires the categories of persons the system may affect.', 'multichoice', { section: 'risk' }),

  // --- Risk ----------------------------------------------------------------
  {
    id: 'ai.riskClass',
    section: 'risk',
    prompt: 'Risk classification',
    why: 'Article 6. If you are unsure, answer "high" and see what the gap report says.',
    type: 'choice',
    choices: ['minimal', 'limited', 'high', 'unacceptable'],
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.riskClass = String(value) as AiRiskClass;
    },
  },
  AI(
    'riskRationale',
    'Why that classification?',
    'Article 6 requires a documented classification. An auditor will ask how you reached it.',
    'text',
    { section: 'risk', when: (a) => a.aiSystem?.riskClass === 'high' || a.aiSystem?.riskClass === 'limited' },
  ),

  // --- Models --------------------------------------------------------------
  AI('models', 'Which models does it call?', 'Annex IV requires identification of the GPAI models used.', 'multichoice', { section: 'models' }),
  AI('modelProviders', 'Which providers?', 'Determines the processor agreements and transfer safeguards you need.', 'multichoice', { section: 'models' }),
  {
    id: 'ai.usesGpai',
    section: 'models',
    prompt: 'Does it use a general-purpose AI model?',
    why: 'Most systems do. It changes which provider obligations you inherit.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.usesGpai = Boolean(value);
    },
  },
  AI('gpaiModelName', 'Which GPAI model?', 'Named so the obligations can be traced.', 'text', {
    section: 'models',
    when: (a) => a.aiSystem?.usesGpai === true,
  }),
  {
    id: 'ai.gpaiSystemicRisk',
    section: 'models',
    prompt: 'Is the model a systemic-risk GPAI under Article 51?',
    why: 'Only if the provider designated it so, or it trained with 10^25 FLOP. Check the provider documentation.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.gpaiSystemicRisk = Boolean(value);
    },
  },

  // --- Data ----------------------------------------------------------------
  AI('dataCategories', 'What categories of personal data are processed?', 'Article 30 requires the categories of personal data processed.', 'multichoice', {
    section: 'data',
    choices: ['identity', 'contact', 'financial', 'health', 'biometric', 'location', 'behavioural', 'communications', 'employment', 'special-category-other'],
  }),
  {
    id: 'ai.processesSpecialCategory',
    section: 'data',
    prompt: 'Is special category data (Article 9) processed?',
    why: 'Health, biometric, and data revealing race, politics, religion or sexuality. Article 9 needs a separate condition.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.processesSpecialCategory = Boolean(value);
    },
  },
  AI(
    'lawfulnessBasis',
    'Lawful basis for the processing',
    'Article 6(1). You need one basis per purpose; legitimate interests requires a balancing test.',
    'multichoice',
    {
      section: 'data',
      choices: ['consent', 'contract', 'legal-obligation', 'vital-interests', 'public-task', 'legitimate-interests'],
    },
  ),
  AI(
    'consentMechanism',
    'How is consent obtained, if consent is the basis?',
    'Article 7. Consent must be freely given, specific, informed, and as easy to withdraw as to give.',
    'text',
    { section: 'data', when: (a) => a.aiSystem?.lawfulnessBasis?.includes('consent') === true },
  ),
  AI('dataProvenance', 'Where does the data come from?', 'Article 10 and Annex IV require the origin of training, validation and testing data.', 'text', { section: 'data' }),
  AI('dataRetentionPeriod', 'How long is it kept?', 'Article 5(1)(e) storage limitation. "As long as needed" is not a period.', 'text', { section: 'data' }),
  AI(
    'anonymisationOrPseudonymisation',
    'Is data anonymised or pseudonymised before it reaches the model?',
    'Determines whether the model provider is processing personal data at all.',
    'text',
    { section: 'data' },
  ),

  // --- Oversight -----------------------------------------------------------
  {
    id: 'ai.automatedDecisionMaking',
    section: 'oversight',
    prompt: 'Does it make decisions without human involvement?',
    why: 'Article 22 GDPR and Article 14 of the AI Act both trigger on this.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.automatedDecisionMaking = Boolean(value);
    },
  },
  AI(
    'humanOversightMeasures',
    'What human oversight measures exist?',
    'Article 14. Must be effective: a person must be able to understand, intervene and stop.',
    'multichoice',
    {
      section: 'oversight',
      choices: [
        'A user can flag an output as incorrect',
        'A reviewer can edit or regenerate the output',
        'A feature flag can disable all model calls',
        'A user can be blocked from further model calls',
        'Oversight activity is logged',
        'Decision thresholds are documented',
      ],
    },
  ),
  AI('humanOversightResponsible', 'Who is responsible for oversight?', 'Annex IV requires the role, not just the measures.', 'text', { section: 'oversight' }),
  AI('humanOversightOfLogs', 'Who reviews the logs?', 'Article 12 requires logs to be reviewable by an authorised person.', 'text', { section: 'oversight' }),

  // --- Safety and accuracy -------------------------------------------------
  AI('accuracyMetrics', 'What accuracy do you measure and what is the current value?', 'Article 15. "It works well" is not a metric.', 'text', { section: 'safety' }),
  AI('evaluationApproach', 'How do you evaluate it?', 'Describe the eval set: size, coverage, and the pass rate you require.', 'text', { section: 'safety' }),
  AI('robustnessMeasures', 'What robustness measures exist?', 'Handling of malformed input, adversarial prompts, and out-of-distribution input.', 'multichoice', {
    section: 'safety',
    choices: [
      'Input length is capped',
      'Output is validated against a schema',
      'Adversarial prompts are in the eval set',
      'The system degrades explicitly rather than guessing',
      'Rate limiting protects the endpoint',
    ],
  }),
  AI('cybersecurityMeasures', 'What cybersecurity measures protect it?', 'Article 15(4). This should overlap with your NIS2 and SOC 2 controls.', 'multichoice', {
    section: 'safety',
    choices: [
      'Authentication on every route',
      'Input validation at the boundary',
      'Rate limiting',
      'Security headers and CSP',
      'Encryption in transit and at rest',
      'Dependency and secret scanning in CI',
      'Audit logging',
    ],
  }),
  {
    id: 'ai.biasAssessmentDone',
    section: 'safety',
    prompt: 'Has a bias or fairness assessment been done?',
    why: 'Not explicitly mandated for every system, but expected under Annex V for high-risk, and useful evidence regardless.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.biasAssessmentDone = Boolean(value);
    },
  },
  AI('biasAssessmentMethod', 'How was it assessed?', 'The method, not just the result.', 'text', {
    section: 'safety',
    when: (a) => a.aiSystem?.biasAssessmentDone === true,
  }),

  // --- Operations ----------------------------------------------------------
  {
    id: 'ai.loggingEnabled',
    section: 'operations',
    prompt: 'Is logging enabled in production?',
    why: 'Article 12. Without logs you cannot demonstrate oversight after the fact.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.loggingEnabled = Boolean(value);
    },
  },
  AI('loggingDetail', 'What exactly is logged?', 'Identifiers and outcomes, not content. Prompt text in logs is a liability.', 'text', { section: 'operations' }),
  AI('retentionOfLogs', 'How long are logs kept?', 'Retention drives both the audit trail and the GDPR storage-limitation obligation.', 'text', { section: 'operations' }),
  AI('postMarketMonitoringPlan', 'What is your post-market monitoring plan?', 'Article 72. What you collect after release, and what threshold triggers action.', 'text', { section: 'operations' }),
  AI('incidentResponseProcess', 'How do you handle a serious malfunction?', 'Article 73 imposes a 24-hour reporting obligation for providers.', 'text', { section: 'operations' }),
  AI('riskManagementApproach', 'Describe your risk management approach in a paragraph.', 'This is the opening of the risk management document. Write it as a person, not a template.', 'text', { section: 'operations' }),
  AI('complaintsProcess', 'How do people complain about its output?', 'Deployers of high-risk AI must provide a complaints mechanism.', 'text', { section: 'operations' }),
  {
    id: 'ai.dataProtectionImpactAssessment',
    section: 'operations',
    prompt: 'Has a DPIA been completed?',
    why: 'Article 35. Almost always required when special category data is processed.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.dataProtectionImpactAssessment = Boolean(value);
    },
  },
  {
    id: 'ai.dpoConsulted',
    section: 'operations',
    prompt: 'Was the DPO consulted?',
    why: 'Article 35(2) requires prior consultation for a high-risk DPIA.',
    type: 'boolean',
    assign: (answer, value) => {
      const ai = (answer.aiSystem ??= {} as AiSystemProfile);
      ai.dpoConsulted = Boolean(value);
    },
  },
];

/**
 * The questions that apply to the answers so far.
 *
 * Conditional questions are skipped rather than asked and ignored: asking
 * someone about their consent mechanism when consent is not the basis teaches
 * them to type `n/a` reflexively, and then they do it for the questions that
 * matter.
 */
export function questionFlow(answer: Partial<ComplianceAnswer>): Question[] {
  return QUESTIONS.filter((q) => !q.when || q.when(answer));
}

/** Parse a raw CLI answer into the right type. */
export function parseAnswer(raw: string, type: Question['type']): string | string[] | boolean | number {
  switch (type) {
    case 'boolean':
      return /^(y|yes|true|1)$/i.test(raw.trim());
    case 'number': {
      const n = Number.parseFloat(raw.replace(/[,\s]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    case 'multichoice':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Suggested frameworks, given the current answers.
 *
 * Exposed so the CLI can show "this will generate: AI Act Annex IV, GDPR ROPA,
 * DPIA" before the last question is answered. People are more willing to answer
 * a long questionnaire when they know what comes out of it.
 */
export function suggestFrameworks(answer: Partial<ComplianceAnswer>): Framework[] {
  const complete: ComplianceAnswer = {
    version: 1,
    completedAt: new Date().toISOString(),
    company: (answer.company ?? {}) as CompanyProfile,
    aiSystem: (answer.aiSystem ?? {}) as AiSystemProfile,
    frameworks: ALL_FRAMEWORKS,
  };
  return inferFrameworks(complete);
}