import { NextResponse } from 'next/server';
import { getLogger } from '@shipready/core';

/**
 * POST /api/csp-report
 * Receives CSP violation reports and logs them.
 */
export async function POST(request: Request): Promise<Response> {
  const logger = getLogger();

  try {
    const body = await request.json();

    // Log CSP violation
    logger.warn('CSP violation reported', {
      directive: body['csp-report']?.['directive'] || body['csp-report']?.['violated-directive'],
      blockedUri: body['csp-report']?.['blocked-uri'] || body['csp-report']?.['blocked-uri'],
      violatedDirective: body['csp-report']?.['violated-directive'] || body['csp-report']?.['violated-directive'],
      originalPolicy: body['csp-report']?.['original-policy'] || body['csp-report']?.['original-policy'],
      disposition: body['csp-report']?.['disposition'],
      referrer: body['csp-report']?.['referrer'],
      scriptSample: body['csp-report']?.['script-sample'],
      statusCode: body['csp-report']?.['status-code'],
    });

    // Always return 204 No Content - we don't want to expose any details
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // Still return 204 to avoid leaking info
    return new NextResponse(null, { status: 204 });
  }
}

/**
 * OPTIONS /api/csp-report
 * CORS preflight.
 */
export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';