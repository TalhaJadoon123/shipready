import { NextRequest, NextResponse } from 'next/server';

/**
 * Simple in-memory rate limiter.
 *
 * For production, replace with Redis-backed limiter (Upstash, etc.)
 * or a dedicated rate-limiting service.
 */

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

const LIMITS: Record<string, RateLimitConfig> = {
  // AI endpoints: stricter limits
  '/api/validate-invoice': { windowMs: 60_000, maxRequests: 30, keyPrefix: 'invoice' },
  '/api/comply/generate': { windowMs: 60_000, maxRequests: 20, keyPrefix: 'comply' },
  '/api/scan': { windowMs: 60_000, maxRequests: 60, keyPrefix: 'scan' },
  // General API: moderate limits
  '/api/': { windowMs: 60_000, maxRequests: 120, keyPrefix: 'api' },
};

// In-memory store (per-process). In multi-instance deployments, use Redis.
const store = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: NextRequest, prefix: string): string {
  // Use Authorization header if present (per-user), else IP
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return `${prefix}:user:${auth.slice(7).slice(0, 16)}`;
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
  return `${prefix}:ip:${ip}`;
}

function checkLimit(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs };
  }

  if (entry.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: config.maxRequests - entry.count, resetAt: entry.resetAt };
}

/**
 * Rate limiting middleware for API routes.
 *
 * Usage in a route handler:
 *   const rateLimitResult = rateLimit(request, '/api/scan');
 *   if (!rateLimitResult.allowed) return rateLimitResult.response;
 */
export function rateLimit(request: NextRequest, path: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  response?: NextResponse;
} {
  // Find the most specific matching limit
  let matchedConfig: RateLimitConfig | null = null;
  let matchedPath = '';

  for (const [limitPath, config] of Object.entries(LIMITS)) {
    if (path.startsWith(limitPath) && limitPath.length > matchedPath.length) {
      matchedConfig = config;
      matchedPath = limitPath;
    }
  }

  if (!matchedConfig) {
    return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 };
  }

  const key = getClientKey(request, matchedConfig.keyPrefix);
  const result = checkLimit(key, matchedConfig);

  if (!result.allowed) {
    const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: result.resetAt,
      response: NextResponse.json(
        { error: 'Too Many Requests', message: `Rate limit exceeded. Try again in ${retryAfter}s.` },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(matchedConfig.maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
          },
        }
      ),
    };
  }

  return {
    allowed: true,
    remaining: result.remaining,
    resetAt: result.resetAt,
  };
}

/**
 * Helper to add rate limit headers to a successful response.
 */
export function addRateLimitHeaders(response: NextResponse, result: ReturnType<typeof rateLimit>): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(LIMITS['/api/']?.maxRequests ?? 120));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  return response;
}