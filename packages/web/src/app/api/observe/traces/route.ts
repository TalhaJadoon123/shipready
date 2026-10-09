import { NextResponse } from 'next/server';
import { parse, isError, postTraceSchema, traceQuerySchema } from '../../../../lib/api-schema.js';
import { listTraces, storeTrace } from '../../../../lib/store.js';
import type { TraceRecord } from '../../../../db/client.js';
import { rateLimit, addRateLimitHeaders } from '../../../../lib/rate-limit.js';

/**
 * POST /api/observe/traces
 *
 * Receives a trace summary the CLI produced. The full event stream is not
 * uploaded: it can be tens of thousands of events per run, and the dashboard
 * shows totals, cost and trends rather than individual events. Per-event
 * inspection stays in the local SQLite file.
 */
export async function POST(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/observe/traces');
  if (!rl.allowed) return rl.response!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return addRateLimitHeaders(NextResponse.json({ error: 'body must be JSON' }, { status: 400 }), rl);
  }

  const parsed = parse(postTraceSchema, body);
  if (isError(parsed)) return addRateLimitHeaders(NextResponse.json(parsed, { status: 400 }), rl);

  const stored = await storeTrace({
    projectId: parsed.projectId,
    trace: parsed.trace as unknown as Record<string, unknown> & {
      id: string;
      startedAt: string;
      command: string,
    },
  });

  return addRateLimitHeaders(NextResponse.json({ ok: true, traceId: stored.traceId }, { status: 201 }), rl);
}

/** GET /api/observe/traces?projectId=... */
export async function GET(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/observe/traces');
  if (!rl.allowed) return rl.response!;

  const url = new URL(request.url);
  const parsed = parse(traceQuerySchema, {
    projectId: url.searchParams.get('projectId') ?? '',
    ...(url.searchParams.get('limit') ? { limit: url.searchParams.get('limit') } : {}),
  });
  if (isError(parsed)) return addRateLimitHeaders(NextResponse.json(parsed, { status: 400 }), rl);

  const traces: TraceRecord[] = await listTraces(parsed.projectId, parsed.limit);

  // Totals across the returned window, which is what the dashboard tiles show.
  const totals = traces.reduce(
    (sum, trace) => ({
      costUsd: sum.costUsd + trace.totalCostUsd,
      inputTokens: sum.inputTokens + trace.inputTokens,
      outputTokens: sum.outputTokens + trace.outputTokens,
      llmCalls: sum.llmCalls + trace.llmCalls,
      toolCalls: sum.toolCalls + trace.toolCalls,
      errors: sum.errors + trace.errors,
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, errors: 0 },
  );

  return addRateLimitHeaders(
    NextResponse.json({
      traces,
      totals,
      // A window where cost is incomplete should be visible, not averaged away.
      costComplete: traces.every((trace) => trace.costComplete),
    }),
    rl,
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';