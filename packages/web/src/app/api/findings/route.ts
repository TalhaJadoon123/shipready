import { NextResponse } from 'next/server';
import { parse, isError, findingsQuerySchema } from '../../../lib/api-schema.js';
import { listFindings, listScans } from '../../../lib/store.js';

/**
 * GET /api/findings?projectId=...
 *
 * Defaults to the most recent scan, because "what is broken right now" is the
 * question this endpoint exists to answer. Pass `scanId` to look at history.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parse(findingsQuerySchema, {
    projectId: url.searchParams.get('projectId') ?? '',
    ...(url.searchParams.get('scanId') ? { scanId: url.searchParams.get('scanId') } : {}),
    ...(url.searchParams.get('severity') ? { severity: url.searchParams.get('severity') } : {}),
    ...(url.searchParams.get('category') ? { category: url.searchParams.get('category') } : {}),
    ...(url.searchParams.get('limit') ? { limit: url.searchParams.get('limit') } : {}),
  });
  if (isError(parsed)) return NextResponse.json(parsed, { status: 400 });

  let findings = (await listFindings(parsed.projectId, parsed.scanId, parsed.limit)) as Record<
    string,
    unknown
  >[];

  if (parsed.severity) findings = findings.filter((f) => f.severity === parsed.severity);
  if (parsed.category) findings = findings.filter((f) => f.category === parsed.category);

  // Worst first, so a truncated response still contains the important rows.
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>;
  findings = [...findings].sort(
    (a, b) => (rank[String(a.severity)] ?? 5) - (rank[String(b.severity)] ?? 5),
  );

  const scans = await listScans(parsed.projectId, 1);
  return NextResponse.json({
    findings,
    total: findings.length,
    scanId: parsed.scanId ?? scans[0]?.id ?? null,
    scannedAt: scans[0]?.createdAt ?? null,
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';