import { NextResponse } from 'next/server';
import { currentDriver } from '../../../lib/store.js';
import { DEFAULT_CI_THRESHOLD } from '../defaults.js';
import { rateLimit, addRateLimitHeaders } from '../../../lib/rate-limit.js';

/**
 * GET /api/health
 *
 * Reports which database driver is in use. This matters more than usual: the
 * dashboard runs with no database at all in development, and an operator needs
 * to be able to see that rather than infer it from missing data.
 */
export async function GET(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/health');
  if (!rl.allowed) return rl.response!;

  const driver = currentDriver();
  return addRateLimitHeaders(
    NextResponse.json({
      ok: true,
      driver,
      version: process.env.npm_package_version ?? '0.1.0',
      defaultThreshold: DEFAULT_CI_THRESHOLD,
      timestamp: new Date().toISOString(),
    }),
    rl,
  );
}

/** Handle CORS preflight for the desktop launcher */
export async function OPTIONS(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/health');
  if (!rl.allowed) return rl.response!;

  return addRateLimitHeaders(
    new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    }),
    rl,
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';