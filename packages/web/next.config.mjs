/**
 * Next.js configuration.
 *
 * Plain `.mjs` rather than TypeScript so `next build` can read it before any
 * type resolution happens -- a config that fails to load takes the build with
 * it, and it should fail for a reason we can see.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The source imports siblings as `.js` (the ESM convention, which Node and
  // tsc both require), but webpack resolves literal filenames. This alias is
  // what lets the same import specifier work in the build, in tsc and in
  // vitest, instead of maintaining three sets of paths.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  // A private dashboard has no business advertising the framework.
  poweredByHeader: false,
  async headers() {
    // Applied to every response, including the API routes. Same headers the
    // scanner tells people to add, so the dashboard practises what it preaches.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default nextConfig;