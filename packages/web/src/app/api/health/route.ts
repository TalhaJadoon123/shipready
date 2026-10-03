import { NextResponse } from 'next/server';
import { currentDriver } from '../../../lib/store.js';
import { DEFAULT_CI_THRESHOLD } from '../defaults.js';

/**
 * GET /api/health
 *
 * Reports which database driver is in use. This matters more than usual: the
 * dashboard runs with no database at all in development, and an operator needs
 * to be able to see that rather than infer it from missing data.
 */
export async function GET(): Promise<Response> {
  const driver = currentDriver();
  return NextResponse.json({
    ok: true,
    driver,
    version: process.env.npm_package_version ?? '0.1.0',
    defaultThreshold: DEFAULT_CI_THRESHOLD,
    timestamp: new Date().toISOString(),
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';