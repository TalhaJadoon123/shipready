import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard is a private app; no need to ship a sitemap.
  poweredByHeader: false,
  experimental: {
    // Keeps the server bundle honest about what reaches the client.
    serverActions: { bodySizeLimit: '8mb' },
  },
};

export default nextConfig;
