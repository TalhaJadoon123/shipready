import { NextResponse } from 'next/server';

/**
 * GET /api/docs/redoc
 * Returns the Redoc UI for the OpenAPI specification.
 */
export async function GET(): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ShipReady Dashboard API Reference</title>
  <link rel="shortcut icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>◈</text></svg>">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #redoc-container { height: 100vh; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
</head>
<body>
  <div id="redoc-container"></div>
  <script>
    Redoc.init('/api/docs/openapi.json', {
      scrollYOffset: 50,
      hideDownloadButton: false,
      hideLoading: false,
      nativeScrollbars: true,
      pathInMiddlePanel: true,
      requiredPropsFirst: true,
      showExtensions: true,
      theme: {
        colors: {
          primary: { main: '#0f172a' },
          background: { main: '#ffffff', alt: '#f8fafc' },
        },
        typography: {
          fontSize: '14px',
          lineHeight: '1.6',
          code: '13px',
          headings: { fontFamily: 'inherit', fontWeight: '600' },
        },
        sidebar: { backgroundColor: '#f8fafc', width: '280px' },
        rightPanel: { backgroundColor: '#f8fafc', width: '400px' },
      },
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';