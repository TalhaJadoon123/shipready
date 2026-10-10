import { NextResponse, type NextRequest } from 'next/server';
import { validateInvoice, fixInvoice, SUPPORTED } from '@shipready/einvoice';
import { parse, isError, validateInvoiceSchema } from '../../../lib/api-schema.js';
import { listInvoices, storeInvoice } from '../../../lib/store.js';
import { rateLimit, addRateLimitHeaders } from '../../../lib/rate-limit.js';

/**
 * POST /api/validate-invoice
 *
 * Validates an e-invoice against its country's schema and business rules, with
 * optional `--fix`-style correction of what can be corrected without guessing.
 *
 * Scope note, repeated from the package: this validates and converts. It does
 * not clear against a tax authority, and it does not claim to. Clearance
 * requires certification as a technical provider in each jurisdiction and
 * carries liability this endpoint cannot honestly take on.
 */
export async function POST(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/validate-invoice');
  if (!rl.allowed) return rl.response!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return addRateLimitHeaders(NextResponse.json({ error: 'body must be JSON' }, { status: 400 }), rl);
  }

  const parsed = parse(validateInvoiceSchema, body);
  if (isError(parsed)) return addRateLimitHeaders(NextResponse.json(parsed, { status: 400 }), rl);

  const fixed = parsed.fix ? fixInvoice(parsed.xml) : null;
  const result = validateInvoice(fixed ? fixed.document : parsed.xml);

  const stored = await storeInvoice({
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    country: result.country,
    documentType: result.documentType,
    number: result.documentNumber,
    issuer: result.issuer,
    total: result.total,
    currency: result.currency,
    valid: result.valid,
    score: result.score,
    issues: result.issues,
  });

  return addRateLimitHeaders(
    NextResponse.json({
      valid: result.valid,
      score: result.score,
      counts: result.counts,
      issues: result.issues,
      computed: result.computed,
      ...(fixed
        ? {
            fixed: {
              changes: fixed.changes,
              remainingErrors: fixed.remaining,
              applied: fixed.applied,
              document: fixed.document,
            },
          }
        : {}),
      invoiceId: stored.invoiceId,
    }),
    rl,
  );
}

/** GET /api/validate-invoice?projectId=... — validation history. */
export async function GET(request: Request): Promise<Response> {
  const rl = rateLimit(request as NextRequest, '/api/validate-invoice');
  if (!rl.allowed) return rl.response!;

  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
  const invoices = await listInvoices(projectId, Number.isFinite(limit) ? limit : 50);

  return addRateLimitHeaders(
    NextResponse.json({
      invoices,
      supported: SUPPORTED,
      // Summarise by validity so the dashboard can show a pass rate without
      // fetching every row and counting in the browser.
      passRate:
        invoices.length === 0
          ? null
          : Math.round((invoices.filter((i) => i.valid).length / invoices.length) * 100),
    }),
    rl,
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
