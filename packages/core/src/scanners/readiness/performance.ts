import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, filesWithExts, JS_EXTS } from './helpers.js';
import type { ScanContext } from '../../types.js';

/**
 * Heaviest client-side dependencies, by minified+gzip cost.
 *
 * Numbers are deliberately pessimistic and come from public bundle reports
 * plus the npm ecosystem's own dependency trees. A dependency is "heavy" here
 * when shipping it costs more than ~50 kB gzipped, which on a mid-range phone
 * is roughly a quarter-second of parse time on a cold cache.
 */
const HEAVY_DEPS: { name: string; gzKb: number; why: string }[] = [
  { name: 'moment', gzKb: 72, why: '288 kB minified; date-fns or Intl covers 90% of uses' },
  { name: 'lodash', gzKb: 71, why: 'import from `lodash-es` per-module, or use the native methods you actually need' },
  { name: 'moment-timezone', gzKb: 130, why: 'very large; `Intl.DateTimeFormat` with a timeZone option replaces most uses' },
  { name: '@fullcalendar/core', gzKb: 120, why: 'large bundle for a calendar' },
  { name: 'chart.js', gzKb: 65, why: 'lazy-load charts, or use a lighter renderer' },
  { name: 'react-chartjs-2', gzKb: 65, why: 'pulls in chart.js; render charts only when visible' },
  { name: 'axios', gzKb: 14, why: 'fetch is built in and ~12 kB smaller' },
  { name: 'jquery', gzKb: 30, why: 'still shipping jQuery in 2026' },
  { name: 'core-js', gzKb: 90, why: 'target modern browsers with a build-tool polyfill list instead of the whole library' },
  { name: 'moment.min.js', gzKb: 72, why: 'bundled moment copy' },
  { name: 'highlight.js', gzKb: 190, why: 'core build is ~1 MB minified; import only the languages you need' },
  { name: 'three', gzKb: 600, why: 'load on demand with dynamic import' },
  { name: 'd3', gzKb: 90, why: 'import the specific modules you use' },
  { name: '@mui/material', gzKb: 90, why: 'import from individual component paths, or use the Joy/CSS-variable build' },
  { name: 'antd', gzKb: 250, why: 'babel-plugin-import pulls only what you use' },
  { name: 'firebase', gzKb: 180, why: 'the modular v9+ API is tree-shakeable; the compat build is not' },
  { name: 'aws-sdk', gzKb: 400, why: 'use `@aws-sdk/client-*` v3, which is modular' },
  { name: 'socket.io-client', gzKb: 42, why: 'acceptable, but ensure it is dynamically imported' },
  { name: 'pdfjs-dist', gzKb: 350, why: 'worker must be dynamically imported' },
  { name: 'monaco-editor', gzKb: 3000, why: 'must be dynamically imported; never in the main bundle' },
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

export const performanceRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/performance/heavy-bundle-dependency',
      name: 'Heavy dependency shipped in the client bundle',
      category: 'performance',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: false,
      description:
        'A large dependency is imported statically, so every visitor downloads and parses it before the page paints. On a mid-range Android phone over 4G, 300 kB gzipped of JavaScript is roughly half a second of blank screen before the app is interactive.',
      remediation:
        'Check the real cost first with a bundle analyser (`@next/bundle-analyzer`, `vite-bundle-visualizer`, `source-map-explorer`). Then either drop the dependency, import the specific submodule, or wrap the import in `await import(...)` with a `<Suspense>` boundary. Set a bundle budget in CI so this does not regress.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['bundle', 'web-vitals', 'performance'],
      references: [
        'https://web.dev/articles/reduce-javascript-payloads-with-tree-shaking',
        'https://nextjs.org/docs/app/building-your-application/optimizing/lazy-loading',
      ],
    },
    function* (ctx, emit) {
      if (!isClientBundle(ctx)) return;
      const pkgPath = ctx.files().find((f) => f === 'package.json');
      const pkg = pkgPath ? filesWithExts(ctx, '.json').find((f) => f.path === pkgPath) : undefined;
      if (!pkg) return;
      let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
      try {
        parsed = JSON.parse(pkg.content);
      } catch {
        return;
      }
      const runtimeDeps = new Set(Object.keys(parsed?.dependencies ?? {}));
      const clientCode = filesWithExts(ctx, ...JS_EXTS)
        .filter((f) => !/(^|\/)(server|api|trpc|lib\/server|_server)\//.test(f.path))
        .map((f) => f.noComments)
        .join('\n');

      let totalGz = 0;
      const hits: { name: string; gzKb: number; why: string; dynamic: boolean }[] = [];
      for (const dep of HEAVY_DEPS) {
        if (!runtimeDeps.has(dep.name) && !new RegExp(`from\\s+['"]${escape(dep.name)}`).test(clientCode)) continue;
        const dynamic = new RegExp(`import\\(\\s*['"]${escape(dep.name)}`).test(clientCode);
        if (dynamic) continue;
        hits.push({ ...dep, dynamic });
        totalGz += dep.gzKb;
      }
      if (hits.length === 0) return;
      hits.sort((a, b) => b.gzKb - a.gzKb);
      const worst = hits[0]!;
      yield emit({
        path: pkg.path,
        line: 1,
        evidence: `${hits.length} heavy dependencies imported statically, ~${totalGz} kB gzipped. Worst: ${worst.name} (~${worst.gzKb} kB) -- ${worst.why}`,
        data: { dependencies: hits.map((h) => h.name), estimatedGzipKb: totalGz },
        severity: totalGz > 300 ? 'high' : 'medium',
        impact: totalGz > 300 ? 'degradation' : 'cosmetic',
        effortMinutes: hits.length * 15,
      });
    },
    (ctx) => isClientBundle(ctx),
  ),

  defineRule(
    {
      id: 'readiness/performance/no-lazy-loading',
      name: 'Heavy routes or components are not lazy loaded',
      category: 'performance',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: false,
      description:
        'Every route or heavy component is imported eagerly. The user downloads the admin dashboard, the settings page, the charting library and the report renderer in order to read the home page.',
      remediation:
        'Use `next/dynamic` for client components, `React.lazy` plus `Suspense` elsewhere, and route-level code splitting. Dynamic import the analytics, chart and editor components -- they are almost never needed on first paint.',
      compliance: [],
      tags: ['bundle', 'code-splitting', 'web-vitals'],
      references: ['https://react.dev/reference/react/lazy'],
    },
    function* (ctx, emit) {
      if (!isClientBundle(ctx)) return;
      if (hasLazyLoading(ctx)) return;
      const pkgPath = ctx.files().find((f) => f === 'package.json');
      yield emit({
        path: pkgPath ?? 'package.json',
        line: 1,
        evidence: 'client bundle with no next/dynamic, React.lazy or dynamic import() anywhere in the project',
      });
    },
    (ctx) => isClientBundle(ctx),
  ),

  defineRule(
    {
      id: 'readiness/performance/no-image-optimization',
      name: 'Images are not optimised',
      category: 'performance',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 40,
      fixable: false,
      description:
        'Large images are served as-is: no responsive `srcSet`, no modern format, no dimensions. An unoptimised 2 MB screenshot on a product page is the single largest payload on most sites, and it is the one users feel most.',
      remediation:
        'Next.js: use `next/image`, which handles format negotiation and lazy loading. Elsewhere: ship AVIF/WebP, add `srcset` with real breakpoints, always set `width` and `height` to reserve space (this is what prevents layout shift), and set `loading="lazy"` below the fold.',
      compliance: [],
      tags: ['images', 'web-vitals', 'lcp'],
      references: ['https://nextjs.org/docs/app/api-reference/components/image'],
    },
    function* (ctx, emit) {
      if (!isClientBundle(ctx)) return;
      if (usesImageOptimisation(ctx)) return;
      const rawImages = allFiles(ctx).filter((f) => IMAGE_EXT.test(f.path));
      if (rawImages.length === 0) return;
      const rawImgTags = countRawImageTags(ctx);
      if (rawImgTags === 0) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `${rawImgTags} raw <img> tag(s) and ${rawImages.length} image asset(s) with no next/image or other optimisation pipeline`,
        data: { rawImgTags, imageAssets: rawImages.length },
      });
    },
    (ctx) => isClientBundle(ctx),
  ),

  defineRule(
    {
      id: 'readiness/performance/no-caching',
      name: 'No caching layer',
      category: 'performance',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.65,
      effortMinutes: 60,
      fixable: false,
      description:
        'No HTTP caching, no CDN, no in-process memoisation of expensive reads, and no Redis. Every request re-queries the database and re-renders. You pay full database cost per page view, and a traffic spike from a launch or a HN front page becomes an outage.',
      remediation:
        'Start with the cheapest wins: set `Cache-Control` on static assets and on GET responses that tolerate staleness, put a CDN in front, and add `revalidate`/`stale-while-revalidate` in Next.js. Add Redis only for hot data you have measured to be hot.',
      compliance: [],
      tags: ['caching', 'cdn', 'scalability'],
      references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching'],
    },
    function* (ctx, emit) {
      if (!hasServer(ctx)) return;
      if (hasCaching(ctx)) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: 'no Cache-Control headers, CDN config, revalidate directive or cache library in a server that reads data',
      });
    },
    (ctx) => hasServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/performance/blocking-request-handler',
      name: 'Synchronous I/O in a request handler',
      category: 'performance',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 30,
      fixable: false,
      description:
        'A request handler uses `readFileSync`, `execSync` or another blocking call. Node runs JavaScript on one thread per process: while the handler is blocked on disk or a subprocess, every other request that worker is handling waits.',
      remediation:
        'Use the async forms (`fs/promises`, `child_process.execFile`). For genuinely CPU-bound work (image processing, large parses, crypto), move it to a worker thread or a job queue and return a job id.',
      compliance: [],
      tags: ['blocking-io', 'latency', 'nodejs'],
      references: ['https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS)) {
        if (/(^|\/)(test|tests|scripts?|bin)\//.test(file.path)) continue;
        if (!/(^|\/)(api|app\/api|routes|pages\/api)\//.test(file.path) && !/(app|server|main|index)\.(ts|js)$/.test(file.path)) continue;
        for (const hit of file.matchNoComments(/\b(readFileSync|writeFileSync|execSync|spawnSync|readdirSync|existsSync|statSync)\s*\(/g)) {
          if (file.hasExplanatoryCommentNear(hit.line, ['startup', 'bootstrap', 'init', 'once', 'top-level'])) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `blocking \`${hit.match}\` in a server path blocks the event loop`,
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/performance/no-compression',
      name: 'No response compression',
      category: 'performance',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.7,
      effortMinutes: 15,
      fixable: true,
      description:
        'No gzip or brotli compression configured for the server. Text payloads travel roughly 4-5x larger than they need to.',
      remediation: 'Add `compression()` middleware in Express, enable gzip in nginx, or set `Content-Encoding` in your CDN. Most hosts (Vercel, Fly, Cloud Run) compress automatically -- verify rather than assume.',
      compliance: [],
      tags: ['compression', 'bandwidth'],
      references: [],
    },
    function* (ctx, emit) {
      if (!hasServer(ctx)) return;
      const text = allFiles(ctx).map((f) => f.content).join('\n');
      if (/\bcompression\s*\(|CompressionMiddleware|gzip|brotli|Content-Encoding|\bcloudflare\b|\bvercel\b/i.test(text)) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: 'no compression middleware or CDN that compresses responses',
        severity: 'low',
        impact: 'cosmetic',
        effortMinutes: 15,
      });
    },
    (ctx) => hasServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/performance/over-fetching-graphql',
      name: 'GraphQL query fetches more than the page needs',
      category: 'performance',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.5,
      effortMinutes: 30,
      fixable: false,
      description:
        'A GraphQL query requests many more fields than the component renders. Over-fetching is the default failure mode of GraphQL and it shows up as a slow page and a large response body.',
      remediation:
        'Split the query to match the component, use fragments per component so they compose without duplication, and add field-level cost analysis in CI with GraphQL Code Analyzer.',
      compliance: [],
      tags: ['graphql', 'payload'],
      references: [],
    },
    function* (ctx, emit) {
      if (!ctx.project.dependencyNames.has('graphql') && !ctx.project.dependencyNames.has('apollo-server')) return;
      const clientCode = filesWithExts(ctx, '.tsx', '.jsx')
        .map((f) => f.noComments)
        .join('\n');
      const deepQueries = clientCode.match(/query\s+\w+\s*(\([^)]*\))?\s*\{[^}]*\{[^}]*\{/g) ?? [];
      if (deepQueries.length < 2) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `${deepQueries.length} GraphQL query(s) nested three or more levels deep -- likely over-fetching`,
        data: { deepQueries: deepQueries.length },
        severity: 'low',
        impact: 'cosmetic',
        confidenceScale: 0.6,
      });
    },
    (ctx) => ctx.project.dependencyNames.has('graphql'),
  ),
];

// ---------------------------------------------------------------------------

function isClientBundle(ctx: ScanContext): boolean {
  return (
    ctx.project.type === 'nextjs' ||
    ctx.project.type === 'vite' ||
    ctx.project.frameworks.includes('react') ||
    ctx.project.frameworks.includes('vue') ||
    ctx.project.frameworks.includes('svelte') ||
    ctx.project.frameworks.includes('angular') ||
    ctx.project.dependencyNames.has('react') ||
    ctx.project.dependencyNames.has('vue')
  );
}

function hasServer(ctx: ScanContext): boolean {
  return (
    ['nextjs', 'express', 'fastapi', 'django', 'go', 'rust', 'node'].includes(ctx.project.type) ||
    ctx.project.apiRoutes.length > 0 ||
    ctx.project.frameworks.some((f) => ['express', 'node-server', 'fastapi', 'django', 'go', 'rust'].includes(f))
  );
}

function hasLazyLoading(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /next\/dynamic|React\.lazy|\blazy\s*\(|import\s*\(|dynamic\s*\(\s*\(\s*\)\s*=>/.test(f.content),
  );
}

function usesImageOptimisation(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /next\/image|@unpic\/react|\bastro:assets|<Image\s|react-image|vite-plugin-image|sharp/.test(f.content),
  );
}

function countRawImageTags(ctx: ScanContext): number {
  let n = 0;
  for (const f of filesWithExts(ctx, '.tsx', '.jsx', '.vue', '.svelte', '.html', '.astro')) {
    n += f.matchNoComments(/<img\s/).length;
  }
  return n;
}

function hasCaching(ctx: ScanContext): boolean {
  if (['ioredis', 'redis', 'cache-manager', 'lru-cache', 'node-cache', 'keyv', '@upstash/redis', '@vercel/kv'].some((d) => ctx.project.dependencyNames.has(d))) return true;
  if (allFiles(ctx).some((f) => /Cache-Control|cacheTag|unstable_cache\s*\(|revalidate\s*[:=]|useSWR|swr|stale-while-revalidate|@cache-control|res\.setHeader\(\s*['"]Cache-Control/.test(f.content))) return true;
  if (ctx.project.frameworks.includes('vercel') || ctx.project.frameworks.includes('cloudflare')) return true;
  return false;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}