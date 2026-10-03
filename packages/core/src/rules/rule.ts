import { internals } from '../context.js';
import { createFinding } from '../finding.js';
import type { SourceFile } from '../source.js';
import {
  impactFor,
} from '../finding.js';
import type {
  ComplianceMapping,
  Finding,
  ProductionImpact,
  ReadinessCategory,
  ScanContext,
  Severity,
  SourceLocation,
} from '../types.js';

/**
 * Static metadata for a check.
 *
 * Rules declare their identity and severity once. Several checks are not
 * static though -- `security/no-rate-limiting` is a blocker for a payments API
 * and a low-priority finding for a public marketing page -- so every field
 * that can legitimately vary per occurrence is overridable at emit time.
 */
export interface RuleMeta {
  id: string;
  name: string;
  category: ReadinessCategory;
  severity: Severity;
  impact: ProductionImpact;
  /** 0-1 baseline confidence. */
  confidence: number;
  description: string;
  remediation: string;
  /** Minutes of engineer time. */
  effortMinutes: number;
  fixable: boolean;
  compliance?: ComplianceMapping[];
  cwe?: string;
  owasp?: string;
  tags?: string[];
  references?: string[];
}

export interface EmitInput {
  path: string;
  line?: number;
  column?: number;
  snippet?: string;
  evidence: string;
  data?: Record<string, unknown>;
  severity?: Severity;
  confidence?: number;
  impact?: ProductionImpact;
  effortMinutes?: number;
  /** Rule-level confidence multiplied by an occurrence multiplier. */
  confidenceScale?: number;
  /** Extra labels to merge onto the finding's tags. */
  tags?: string[];
}

/** Build a Finding from rule metadata plus one occurrence. */
export function emit(ctx: ScanContext, meta: RuleMeta, input: EmitInput): Finding {
  void ctx;
  return createFinding({
    ruleId: meta.id,
    title: meta.name,
    description: meta.description,
    severity: input.severity ?? meta.severity,
    confidence: (input.confidence ?? meta.confidence) * (input.confidenceScale ?? 1),
    category: meta.category,
    location: buildLocation(input),
    evidenceSummary: input.evidence,
    ...(input.data ? { evidenceData: input.data } : {}),
    remediation: meta.remediation,
    compliance: meta.compliance ?? [],
    productionImpact: input.impact ?? meta.impact,
    tags: [...(meta.tags ?? []), ...(input.tags ?? [])],
    ...(meta.cwe ? { cwe: meta.cwe } : {}),
    ...(meta.owasp ? { owasp: meta.owasp } : {}),
    fixable: meta.fixable,
    effortMinutes: input.effortMinutes ?? meta.effortMinutes,
    references: meta.references ?? [],
    source: meta.id.split('/')[0] ?? 'readiness',
  });
}

function buildLocation(input: EmitInput): SourceLocation {
  const location: SourceLocation = { path: input.path, startLine: Math.max(1, input.line ?? 1) };
  if (input.column !== undefined) location.startColumn = input.column;
  if (input.snippet !== undefined) location.snippet = input.snippet;
  return location;
}

/**
 * Create a rule with sensible defaults so individual rules stay short.
 * Every rule in the catalogue is defined through this factory, which is what
 * guarantees every finding has complete metadata.
 */
export function rule(meta: Partial<RuleMeta> & Pick<RuleMeta, 'id' | 'name' | 'category' | 'description' | 'remediation'>): RuleMeta {
  const severity = meta.severity ?? 'medium';
  return {
    severity,
    impact: meta.impact ?? impactFor(severity),
    confidence: meta.confidence ?? 0.85,
    effortMinutes: meta.effortMinutes ?? 45,
    fixable: meta.fixable ?? false,
    ...meta,
  } as RuleMeta;
}

// ---------------------------------------------------------------------------
// Shared compliance mapping shorthands. Referenced by many rules, so keeping
// them in one place stops the same citation drifting between rules.
// ---------------------------------------------------------------------------

export const COMPLIANCE = {
  euAiActArticle9: {
    framework: 'eu-ai-act',
    article: 'Article 9',
    requirement: 'Risk management system must be continuous and documented',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle10: {
    framework: 'eu-ai-act',
    article: 'Article 10',
    requirement: 'Training, validation and testing data sets must be governed',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle12: {
    framework: 'eu-ai-act',
    article: 'Article 12',
    requirement: 'Automatic event recording for traceability',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle13: {
    framework: 'eu-ai-act',
    article: 'Article 13',
    requirement: 'Instructions for use and transparency to deployers',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle14: {
    framework: 'eu-ai-act',
    article: 'Article 14',
    requirement: 'Human oversight measures must be effective',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle15: {
    framework: 'eu-ai-act',
    article: 'Article 15',
    requirement: 'Accuracy, robustness and cybersecurity',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle17: {
    framework: 'eu-ai-act',
    article: 'Article 17',
    requirement: 'Quality management system',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle19: {
    framework: 'eu-ai-act',
    article: 'Article 19',
    requirement: 'Automatically generated logs retained under provider control',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle26: {
    framework: 'eu-ai-act',
    article: 'Article 26',
    requirement: 'Obligations of deployers of high-risk AI systems',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle50: {
    framework: 'eu-ai-act',
    article: 'Article 50',
    requirement: 'Transparency obligations for certain AI systems',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  euAiActArticle72: {
    framework: 'eu-ai-act',
    article: 'Article 72',
    requirement: 'Post-market monitoring plan',
    reference: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  gdprArticle5: {
    framework: 'gdpr',
    article: 'Article 5',
    requirement: 'Principles relating to processing of personal data',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle25: {
    framework: 'gdpr',
    article: 'Article 25',
    requirement: 'Data protection by design and by default',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle30: {
    framework: 'gdpr',
    article: 'Article 30',
    requirement: 'Records of processing activities',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle17: {
    framework: 'gdpr',
    article: 'Article 17',
    requirement: 'Right to erasure, with exceptions for legal retention duties',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle15: {
    framework: 'gdpr',
    article: 'Article 15',
    requirement: 'Right of access by the data subject',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle12: {
    framework: 'gdpr',
    article: 'Article 12',
    requirement: 'Transparent information and communication',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle32: {
    framework: 'gdpr',
    article: 'Article 32',
    requirement: 'Security of processing',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle33: {
    framework: 'gdpr',
    article: 'Article 33',
    requirement: 'Notification of personal data breach within 72 hours',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  gdprArticle35: {
    framework: 'gdpr',
    article: 'Article 35',
    requirement: 'Data protection impact assessment',
    reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  owaspA01: {
    framework: 'owasp-top-10',
    article: 'A01:2021',
    requirement: 'Broken Access Control',
    reference: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/',
  },
  owaspA02: {
    framework: 'owasp-top-10',
    article: 'A02:2021',
    requirement: 'Cryptographic Failures',
    reference: 'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/',
  },
  owaspA03: {
    framework: 'owasp-top-10',
    article: 'A03:2021',
    requirement: 'Injection',
    reference: 'https://owasp.org/Top10/A03_2021-Injection/',
  },
  owaspA04: {
    framework: 'owasp-top-10',
    article: 'A04:2021',
    requirement: 'Insecure Design',
    reference: 'https://owasp.org/Top10/A04_2021-Insecure_Design/',
  },
  owaspA05: {
    framework: 'owasp-top-10',
    article: 'A05:2021',
    requirement: 'Security Misconfiguration',
    reference: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/',
  },
  owaspA07: {
    framework: 'owasp-top-10',
    article: 'A07:2021',
    requirement: 'Identification and Authentication Failures',
    reference: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/',
  },
  owaspA09: {
    framework: 'owasp-top-10',
    article: 'A09:2021',
    requirement: 'Security Logging and Monitoring Failures',
    reference: 'https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/',
  },
  llmTop10PromptInjection: {
    framework: 'owasp-llm-top-10',
    article: 'LLM01',
    requirement: 'Prompt Injection',
    reference: 'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
  },
  llmTop10SensitiveInfo: {
    framework: 'owasp-llm-top-10',
    article: 'LLM02',
    requirement: 'Insecure Output Handling',
    reference: 'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
  },
  llmTop10ExcessiveAgency: {
    framework: 'owasp-llm-top-10',
    article: 'LLM06',
    requirement: 'Excessive Agency',
    reference: 'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
  },
  llmTop10Unbounded: {
    framework: 'owasp-llm-top-10',
    article: 'LLM10',
    requirement: 'Unbounded Consumption',
    reference: 'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
  },
  iso27001A8: {
    framework: 'iso-27001',
    article: 'A.8.25',
    requirement: 'Secure development life cycle',
    reference: 'https://www.iso.org/standard/27001',
  },
  iso27001A5: {
    framework: 'iso-27001',
    article: 'A.5.15',
    requirement: 'Access control',
    reference: 'https://www.iso.org/standard/27001',
  },
  iso27001A5_19: {
    framework: 'iso-27001',
    article: 'A.5.19',
    requirement: 'Information security in supplier relationships',
    reference: 'https://www.iso.org/standard/27001',
  },
  soc2CC6: {
    framework: 'soc2',
    article: 'CC6.1',
    requirement: 'Logical access security',
    reference: 'https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services',
  },
  soc2CC7: {
    framework: 'soc2',
    article: 'CC7.2',
    requirement: 'Monitoring for anomalies',
    reference: 'https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services',
  },
  nis2Art21: {
    framework: 'nis2',
    article: 'Article 21',
    requirement: 'Cybersecurity risk-management measures',
    reference: 'https://eur-lex.europa.eu/eli/dir/2022/2555/oj',
  },
} satisfies Record<string, ComplianceMapping>;

// ---------------------------------------------------------------------------
// Iterating parsed files
// ---------------------------------------------------------------------------

/** Iterate every parsed file matching a predicate, sorted for determinism. */
export function* eachFile(ctx: ScanContext, predicate: (file: SourceFile) => boolean): Generator<SourceFile> {
  for (const file of internals.parseAll(ctx, predicate)) yield file;
}

/** All files of the given extensions. */
export function filesWithExtensions(ctx: ScanContext, ...exts: string[]): SourceFile[] {
  const set = new Set(exts);
  return internals.parseAll(ctx, (f) => {
    const dot = f.path.lastIndexOf('.');
    return dot >= 0 && set.has(f.path.slice(dot));
  });
}

export function allSourceFiles(ctx: ScanContext): SourceFile[] {
  return internals.parseAll(ctx, () => true);
}

/** The first line matching a pattern, or 1. */
export function lineOfFirstMatch(file: SourceFile, re: RegExp): number {
  for (let i = 1; i <= file.lineCount; i++) {
    if (re.test(file.line(i))) return i;
  }
  return 1;
}
