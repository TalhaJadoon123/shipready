import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  generate,
  findGaps,
  inferFrameworks,
  toDocxBundle,
  toJsonBundle,
  toMarkdownBundle,
  buildManifest,
  formatComplianceReport,
  type ComplianceAnswer,
} from '@shipready/compliance';
import { parse, isError, postComplianceSchema } from '../../../../lib/api-schema.js';
import { listCompliance, storeCompliance } from '../../../../lib/store.js';

/**
 * POST /api/comply/generate
 *
 * Generates the documentation pack from questionnaire answers.
 *
 * The documents are returned, not stored. They are regulatory documents about
 * the customer's own business and belong on their filesystem; only the version
 * record (score, frameworks, gaps) is recorded, which is what the dashboard
 * needs in order to trend compliance readiness over time.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  // The envelope is validated separately from the answers: the answers are a
  // free-form questionnaire, and rejecting them here would block the gap
  // analysis that tells the user what is missing.
  const envelope = parse(postComplianceSchema, body);
  if (!isError(envelope) && 'projectId' in envelope && typeof envelope.projectId === 'string') {
    // A pack record was posted rather than an answer set.
    const pack = (body as { pack?: Record<string, unknown> }).pack ?? {};
    const stored = await storeCompliance({
      projectId: envelope.projectId,
      pack: {
        company: String(pack.company ?? 'Unknown'),
        systemName: String(pack.systemName ?? 'Unknown'),
        jurisdiction: String(pack.jurisdiction ?? 'EU'),
        frameworks: (pack.frameworks as string[]) ?? [],
        score: Number(pack.score ?? 0),
        gaps: (pack.gaps as unknown[]) ?? [],
        documentCount: Number(pack.documentCount ?? 0),
      },
    });
    return NextResponse.json({ ok: true, complianceId: stored.complianceId }, { status: 201 });
  }

  const answers = (body as { answer?: ComplianceAnswer }).answer;
  if (!answers || typeof answers !== 'object') {
    return NextResponse.json({ error: 'answer is required' }, { status: 400 });
  }

  const result = generate(answers as ComplianceAnswer);
  const manifest = buildManifest(answers as ComplianceAnswer, result);

  // Gaps come from the answers, not only from the generated pack: a gap that
  // did not surface as a placeholder is still a gap.
  const gaps = result.gaps.length > 0 ? result.gaps : findGaps(answers as ComplianceAnswer);
  const bundle = bundleFor(body as { format?: string }, result, manifest);

  return NextResponse.json({
    frameworks: inferFrameworks(answers as ComplianceAnswer),
    documents: result.documents.map((document) => ({
      id: document.id,
      title: document.title,
      reference: document.reference,
      gapCount: document.gaps.length,
      unresolved: document.unresolved,
      ...(bundle ? { content: renderDocument(bundle, document.id) } : { markdown: document.content }),
    })),
    gaps,
    score: result.score,
    report: formatComplianceReport(
      buildDashboardShim(result, gaps),
    ),
  });
}

/** GET /api/comply/generate?projectId=... — pack history. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const packs = await listCompliance(projectId, 20);
  return NextResponse.json({ packs, latest: packs[0] ?? null });
}

function bundleFor(
  input: { format?: string },
  result: Parameters<typeof generate>[0] extends never ? never : ReturnType<typeof generate>,
  manifest: ReturnType<typeof buildManifest>,
) {
  switch (input.format) {
    case 'md':
    case 'markdown':
      return toMarkdownBundle(result, manifest);
    case 'json':
      return toJsonBundle(result, manifest);
    case 'docx':
      return toDocxBundle(result, manifest);
    default:
      return null;
  }
}

function renderDocument(bundle: ReturnType<typeof toMarkdownBundle>, documentId: string): string {
  const file = bundle.files.find((f) => f.path.includes(documentId.split('/')[1] ?? ''));
  return typeof file?.content === 'string' ? file.content : '';
}

/** A minimal dashboard-shaped object so the CLI and the API agree on format. */
function buildDashboardShim(
  result: ReturnType<typeof generate>,
  gaps: ReturnType<typeof findGaps>,
) {
  return {
    score: result.score,
    blockers: gaps.filter((g) => g.severity === 'blocker').length,
    totalGaps: gaps.length,
    frameworks: result.frameworks.map((framework) => ({
      framework,
      label: framework,
      ready: gaps.every((g) => g.severity !== 'blocker'),
      documentsComplete: result.documents.filter((d) => d.framework === framework).length,
      documentsTotal: result.documents.filter((d) => d.framework === framework).length,
      completion: 100,
      blockers: gaps.filter((g) => g.severity === 'blocker').length,
      gaps: gaps.filter((g) => g.id.startsWith(framework)),
      nextAction: gaps[0]?.action ?? 'Review and sign off the generated documents',
      documentIds: result.documents.filter((d) => d.framework === framework).map((d) => d.id),
    })),
    nextAction: gaps[0]?.action ?? 'Review and sign off the generated documents',
    estimatedDaysToReady: Math.max(0, Math.round(gaps.filter((g) => g.severity === 'blocker').length * 2)),
    documents: result.documents.map((d) => ({
      id: d.id,
      title: d.title,
      reference: d.reference,
      gaps: d.gaps.length,
    })),
    scan: null,
    generatedAt: result.generatedAt,
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

void z;