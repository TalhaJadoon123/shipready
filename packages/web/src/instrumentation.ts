/**
 * Sentry initialisation for Next.js 15+.
 *
 * Uses @sentry/nextjs which is designed for Next.js App Router.
 * Register as instrumentation hook in next.config.js (not needed in Next.js 15+):
 *
 *   // experimental: { instrumentationHook: true } // Not needed in Next.js 15+
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
});

// Re-export for use in other server-side code
export { Sentry };

// Report handled errors from the global error handler:
//   Sentry.captureException(err);
//
// Add breadcrumbs in the request middleware:
//   Sentry.addBreadcrumb({ category: 'http', message: req.originalUrl });