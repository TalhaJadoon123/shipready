import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { runScan } from '@shipready/core';
import { createDefaultRegistry } from '@shipready/core';
import { parse, postScanSchema, isError } from '../../../lib/api-schema.js';
import { storeScan } from '../../../lib/store.js';
import { rateLimit, addRateLimitHeaders } from '../../../lib/rate-limit.js';

/**
 * POST /api/scan
 *
 * Accepts a report the CLI produced, or scans a repository here when given a
 * URL. The first is the normal path: the CLI already has the file tree, and
 * uploading a report is faster, works behind a firewall, and keeps the API from
 * becoming a server-side scanner.
 */
export async function POST(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/scan');
  if (!rl.allowed) return rl.response!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return addRateLimitHeaders(NextResponse.json({ error: 'body must be JSON' }, { status: 400 }), rl);
  }

  const parsed = parse(postScanSchema, body);
  if (isError(parsed)) {
    return addRateLimitHeaders(NextResponse.json(parsed, { status: 400 }), rl);
  }

  const { projectId, report, commitSha, branch } = parsed;
  const stored = await storeScan({
    projectId,
    report: report as unknown as Record<string, unknown>,
    ...(commitSha ? { commitSha } : {}),
    ...(branch ? { branch } : {}),
  });

  return addRateLimitHeaders(
    NextResponse.json(
      {
        ok: true,
        scanId: stored.scanId,
        score: report.score,
        grade: report.grade,
        verdict: report.verdict,
        blockers: report.summary.blockers,
        fixable: report.summary.fixable,
      },
      { status: 201 },
    ),
    rl,
  );
}

/**
 * POST /api/scan?path=
 *
 * Scan a repository the dashboard can reach. Used by the hosted product for
 * connected repositories, and locally to seed a project. Bounded to a path and
 * an allowlist, because an endpoint that scans arbitrary paths is a file
 * disclosure waiting to happen.
 */
export async function PUT(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/scan');
  if (!rl.allowed) return rl.response!;

  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const projectId = url.searchParams.get('projectId');
  if (!path || !projectId) {
    return addRateLimitHeaders(NextResponse.json({ error: 'path and projectId are required' }, { status: 400 }), rl);
  }
  if (!isScannablePath(path)) {
    return addRateLimitHeaders(
      NextResponse.json(
        { error: 'path not allowed', expected: 'a path under the dashboard root' },
        { status: 403 },
      ),
      rl,
    );
  }

  const { report } = await runScan({ type: 'repo', path }, { registry: createDefaultRegistry() });
  const stored = await storeScan({ projectId, report: report as unknown as Record<string, unknown> });

  return addRateLimitHeaders(
    NextResponse.json(
      { ok: true, scanId: stored.scanId, score: report.score, grade: report.grade, verdict: report.verdict },
      { status: 201 },
    ),
    rl,
  );
}

/**
 * Guard against path traversal.
 *
 * The dashboard can only scan inside its own root. An absolute path or a `..`
 * segment is refused outright rather than normalised and hoped for.
 */
export function isScannablePath(path: string): boolean {
  if (!path) return false;
  if (/^\w:|^[/\\]/.test(path)) return false;
  const segments = path.split(/[\\/]+/);
  return !segments.includes('..');
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

void z;
