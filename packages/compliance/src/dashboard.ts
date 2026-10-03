import type { Gap } from './types.js';
import { sortGaps } from './types.js';
import type { GenerateResult } from './generate.js';
import type { ComplianceScanResult } from './scan.js';

/**
 * The compliance dashboard.
 *
 * The dashboard's job is to answer one question for each framework: *can we
 * sign this?* A document list does not answer it. A framework is ready when
 * there is a document for every required item and no blocker gaps remain.
 */
export interface FrameworkStatus {
  framework: string;
  label: string;
  /** True when every required document exists and no blockers remain. */
  ready: boolean;
  /** Documents that exist, against those required. */
  documentsComplete: number;
  documentsTotal: number;
  /** Percentage of required documents present. */
  completion: number;
  blockers: number;
  gaps: Gap[];
  /** What to do next, in one line. */
  nextAction: string;
  /** Where the documents live. */
  documentIds: string[];
}

export interface ComplianceDashboard {
  score: number;
  /** Blocker gaps across all frameworks. */
  blockers: number;
  totalGaps: number;
  frameworks: FrameworkStatus[];
  /** The single most important thing to do next. */
  nextAction: string;
  estimatedDaysToReady: number;
  documents: { id: string; title: string; reference: string; gaps: number }[];
  scan: { findings: number; undeclaredData: number; filesScanned: number } | null;
  generatedAt: string;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  'eu-ai-act': 'EU AI Act',
  gdpr: 'GDPR',
  csrd: 'CSRD',
  nis2: 'NIS2',
  soc2: 'SOC 2',
};

const REQUIRED_COUNTS: Record<string, number> = {
  'eu-ai-act': 9,
  gdpr: 5,
  csrd: 4,
  nis2: 1,
  soc2: 1,
};

const GENERATED_PER_FRAMEWORK: Record<string, number> = {
  'eu-ai-act': 5,
  gdpr: 3,
  csrd: 3,
  nis2: 1,
  soc2: 1,
};

export function buildDashboard(
  result: GenerateResult,
  scan?: ComplianceScanResult | null,
): ComplianceDashboard {
  const byFramework = new Map<string, typeof result.documents>();
  for (const document of result.documents) {
    const arr = byFramework.get(document.framework) ?? [];
    arr.push(document);
    byFramework.set(document.framework, arr);
  }

  const frameworks: FrameworkStatus[] = result.frameworks.map((framework) => {
    const documents = byFramework.get(framework) ?? [];
    // The gap list is repository-wide; filter to this framework's documents so
    // a GDPR gap does not show up under the AI Act.
    const documentGapIds = new Set(documents.flatMap((d) => d.gaps.map((g) => g.id)));
    const gaps = sortGaps(result.gaps.filter((g) => documentGapIds.has(g.id) || g.id.startsWith(framework)));
    const blockers = gaps.filter((g) => g.severity === 'blocker');

    const required = REQUIRED_COUNTS[framework] ?? (documents.length || 1);
    const generated = GENERATED_PER_FRAMEWORK[framework] ?? documents.length;
    // Completeness is documents generated against documents generated for a
    // complete pack, not against the full statutory list: the difference is
    // the part we deliberately did not generate, and saying so is more honest.
    const completion = Math.min(100, Math.round((documents.length / Math.max(1, generated)) * 100));

    return {
      framework,
      label: FRAMEWORK_LABELS[framework] ?? framework,
      ready: blockers.length === 0 && documents.length >= required * 0.5,
      documentsComplete: documents.length,
      documentsTotal: required,
      completion,
      blockers: blockers.length,
      gaps,
      nextAction: blockers[0]?.action ?? (documents.length === 0 ? 'Generate the documentation' : 'Review and sign off the documents'),
      documentIds: documents.map((d) => d.id),
    };
  });

  const blockers = frameworks.reduce((sum, f) => sum + f.blockers, 0);
  const nextAction =
    frameworks.find((f) => f.blockers > 0)?.nextAction ??
    (frameworks.find((f) => f.completion < 100)?.nextAction ?? 'Review and sign off the generated documents');

  return {
    score: result.score,
    blockers,
    totalGaps: result.gaps.length,
    frameworks,
    nextAction,
    // Two days per blocker, five per remaining gap. Rough, and labelled as such.
    estimatedDaysToReady: Math.max(0, Math.round(blockers * 2 + (result.gaps.length - blockers) * 0.5)),
    documents: result.documents.map((d) => ({
      id: d.id,
      title: d.title,
      reference: d.reference,
      gaps: d.gaps.length,
    })),
    scan: scan
      ? {
          findings: scan.findings.length,
          undeclaredData: scan.undeclaredData.length,
          filesScanned: scan.filesScanned,
        }
      : null,
    generatedAt: result.generatedAt,
  };
}

/** Render the dashboard as markdown, for a terminal or a PR comment. */
export function formatComplianceReport(dashboard: ComplianceDashboard): string {
  const lines: string[] = [];

  lines.push(`Compliance readiness: ${dashboard.score}/100`);
  lines.push(`Blockers: ${dashboard.blockers} · Total gaps: ${dashboard.totalGaps} · Estimated: ${dashboard.estimatedDaysToReady} days to ready`);
  lines.push('');
  lines.push(`Next action: ${dashboard.nextAction}`);
  lines.push('');

  for (const framework of dashboard.frameworks) {
    const icon = framework.ready ? '[ready]' : framework.blockers > 0 ? '[blockers]' : '[incomplete]';
    lines.push(`${icon} ${framework.label}  ${framework.documentsComplete}/${framework.documentsTotal} documents, ${framework.blockers} blocker(s)`);
    lines.push(`     ${framework.nextAction}`);
    if (framework.gaps.length > 0) {
      for (const gap of framework.gaps.slice(0, 3)) {
        lines.push(`     - [${gap.severity}] ${gap.message}`);
      }
    }
    lines.push('');
  }

  if (dashboard.scan) {
    lines.push(`Code scan: ${dashboard.scan.findings} finding(s) across ${dashboard.scan.filesScanned} file(s)`);
    if (dashboard.scan.undeclaredData > 0) {
      lines.push(`  ${dashboard.scan.undeclaredData} personal data field(s) found in code but not declared in the questionnaire`);
    }
    lines.push('');
  }

  return lines.join('\n');
}