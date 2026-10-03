import { NextResponse } from 'next/server';
import { parse, isError, trendsQuerySchema } from '../../../lib/api-schema.js';
import { trends, latestScan } from '../../../lib/store.js';

/**
 * GET /api/trends?projectId=...
 *
 * The readiness score over time, plus the category scores from the latest scan
 * for the radar chart. Returned together so the dashboard renders from one
 * request and cannot show a score line from one scan beside categories from
 * another.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parse(trendsQuerySchema, {
    projectId: url.searchParams.get('projectId') ?? '',
    ...(url.searchParams.get('limit') ? { limit: url.searchParams.get('limit') } : {}),
  });
  if (isError(parsed)) return NextResponse.json(parsed, { status: 400 });

  const points = await trends(parsed.projectId, parsed.limit);
  const latest = await latestScan(parsed.projectId);

  const categories = (latest?.categories ?? {}) as Record<string, { score: number; blockers: number }>;

  const first = points[0];
  const last = points.at(-1);
  const delta = first && last ? last.score - first.score : 0;

  return NextResponse.json({
    points,
    categories,
    delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    latest: latest
      ? {
          score: latest.score,
          grade: latest.grade,
          verdict: latest.verdict,
          blockers: latest.blockers,
          scannedAt: latest.createdAt,
          commitSha: latest.commitSha,
          branch: latest.branch,
        }
      : null,
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';