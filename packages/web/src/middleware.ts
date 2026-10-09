import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Middleware for dashboard authentication.
 *
 * In development (NODE_ENV !== 'production'), authentication is skipped
 * to allow local development without setup. In production, a valid
 * authorization header or cookie is required.
 *
 * The authentication mechanism is intentionally simple: a shared secret
 * passed via the Authorization header or SHIPREADY_DASHBOARD_TOKEN cookie.
 * For production deployments, replace this with your identity provider
 * (OAuth, OIDC, SAML, etc.) by implementing a proper session validation.
 */

const AUTH_HEADER = 'authorization';
const COOKIE_NAME = 'SHIPREADY_DASHBOARD_TOKEN';
const EXPECTED_TOKEN = process.env.SHIPREADY_DASHBOARD_TOKEN;

function isAuthenticated(request: NextRequest): boolean {
  // Skip auth in development
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  // No token configured = no auth enforcement (but warn)
  if (!EXPECTED_TOKEN) {
    console.warn('[shipready] SHIPREADY_DASHBOARD_TOKEN not set; dashboard is unprotected in production');
    return false;
  }

  // Check Authorization header: Bearer <token>
  const authHeader = request.headers.get(AUTH_HEADER);
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === EXPECTED_TOKEN) return true;
  }

  // Check cookie
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieToken === EXPECTED_TOKEN) return true;

  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    const allowedOrigin = process.env.NODE_ENV === 'production'
      ? (process.env.SHIPREADY_CORS_ORIGIN ?? 'https://your-domain.com')
      : '*';
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Skip auth for health checks and static assets
  if (pathname.startsWith('/api/health') || pathname.startsWith('/_next/') || pathname.startsWith('/static/')) {
    return NextResponse.next();
  }

  // Skip auth for favicon, robots, etc.
  if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
    return NextResponse.next();
  }

  if (!isAuthenticated(request)) {
    // API routes get JSON error
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Valid Authorization header or session cookie required' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
      );
    }

    // Browser routes redirect to a simple login page (or 401)
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><title>401 Unauthorized</title><style>
body{font-family:system-ui;padding:2rem;max-width:400px;margin:auto;text-align:center}
code{background:#f5f5f5;padding:.2rem.4rem;border-radius:4px}
</style></head>
<body>
<h1>🔒 ShipReady Dashboard</h1>
<p>Authentication required.</p>
<p>Set the <code>Authorization: Bearer <token></code> header or <code>SHIPREADY_DASHBOARD_TOKEN</code> cookie.</p>
<p>Token must match <code>SHIPREADY_DASHBOARD_TOKEN</code> environment variable.</p>
</body></html>`,
      { status: 401, headers: { 'Content-Type': 'text/html' } }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - /api/health (health checks)
     * - /_next/ (Next.js internals)
     * - /static/ (static files)
     * - favicon.ico, robots.txt
     */
    '/((?!api/health|_next|static|favicon.ico|robots.txt).*)',
  ],
};