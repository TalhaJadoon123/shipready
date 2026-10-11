import { NextResponse } from 'next/server';
import { openApiDocument } from '@/lib/openapi.js';

/**
 * GET /api/docs/openapi.json
 * Returns the OpenAPI 3.1 specification as JSON.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(openApiDocument, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/**
 * OPTIONS /api/docs/openapi.json
 * CORS preflight.
 */
export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';