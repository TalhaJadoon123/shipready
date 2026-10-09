import { NextResponse } from 'next/server';
import { parse, isError, trendsQuerySchema } from '../../../lib/api-schema.js';
import { trends, latestScan } from '../../../lib/store.js';
import { rateLimit, addRateLimitHeaders } from '../../../lib/rate-limit.js';

/**
 * GET /api/trends?projectId=...
 *
 * The readiness score over time, plus the category scores from the latest scan
 * for the radar chart. Returned together so the dashboard renders from one
 * request and cannot show a score line from one scan beside categories from
 * another.
 */
export async function GET(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/trends');
  if (!rl.allowed) return rl.response!;

  const url = new URL(request.url);
  const parsed = parse(trendsQuerySchema, {
    projectId: url.searchParams.get('projectId') ?? '',
    ...(url.searchParams.get('limit') ? { limit: url.searchParams.get('limit') } : {}),
  });
  if (isError(parsed)) return addRateLimitHeaders(NextResponse.json(parsed, { status: 400 }), rl);

  const points = await trends(parsed.projectId, parsed.limit);
  const latest = await latestScan(parsed.projectId);

  const categories = (latest?.categories ?? {}) as Record<string, { score: number; blockers: number }>;

  const first = points[0];
  const last = points.at(-1);
  const delta = first && last ? last.score - first.score : 0;

  return addRateLimitHeaders(
    NextResponse.json({
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
    }),
    rl,
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';