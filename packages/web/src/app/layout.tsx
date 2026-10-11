import type { Metadata } from 'next';
import './globals.css';

/**
 * The dashboard shell.
 *
 * One page rather than a route per view. The data is four API calls and the
 * whole thing is one screen: a score, a category breakdown, what to fix, what
 * the agent is spending, where compliance stands. Splitting it across routes
 * would mean navigation the user does not need.
 */
export const metadata: Metadata = {
  title: 'ShipReady',
  description: 'Vibe-coded. Production-proven.',
};

// Explicit return type: Next infers the component's type and needs to name it
// in the generated route manifest, which it cannot do across a pnpm store path.
export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
