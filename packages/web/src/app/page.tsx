import { use } from 'react';
import { latestScan } from '../lib/store.js';
import { TrendsChart, RadarChart } from '../components/charts.js';
import { BlockerList } from '../components/blockers.js';

/**
 * The dashboard.
 *
 * Server-rendered: the first paint contains real data, not a spinner followed
 * by data. This matters for a page whose whole purpose is to answer "is this
 * shippable?" -- an empty page that fills in two seconds later reads as "no
 * information", and the user leaves.
 */
export const dynamic = 'force-dynamic';

// Explicit return type for the same reason as RootLayout: Next has to write
// this component's type into the route manifest.
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = typeof params.project === 'string' ? params.project : 'default';
  const scan = await latestScan(projectId);

  if (!scan) return <EmptyState projectId={projectId} />;

  const report = scan.report as {
    categories?: { category: string; label: string; score: number; weight: number; findingCount: number; blockers: number }[];
    summary?: { estimatedTimeToLaunch: string; fixable: number; totalFindings: number };
  };

  const categories = report.categories ?? [];
  const summary = report.summary;
  const blockers = (scan.report as { topBlockers?: { title: string; path: string; line: number; remediation: string; effortMinutes: number; productionImpact: string }[] }).topBlockers ?? [];

  return (
    <div className="wrap">
      <header>
        <h1>ShipReady</h1>
        <div className="sub">
          Project <code>{projectId}</code>
          {scan.branch ? ` · branch ${scan.branch}` : ''}
          {scan.commitSha ? ` · ${scan.commitSha.slice(0, 7)}` : ''} · scanned{' '}
          {new Date(scan.createdAt).toLocaleString()}
        </div>
      </header>

      <div style={{ height: 20 }} />

      <div className="hero">
        <div>
          <div className="stat-label">Readiness</div>
          <div className="score" style={{ color: verdictColour(scan.verdict) }}>
            {scan.score}
          </div>
          <div className="sub">grade {scan.grade} / 100</div>
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="stat-label">Verdict</div>
          <div style={{ margin: '6px 0 12px' }}>
            <span className="verdict" style={{ background: verdictColour(scan.verdict) }}>
              {scan.verdict}
            </span>
          </div>
          <Bar score={scan.score} />
        </div>
      </div>

      <h2>Summary</h2>
      <div className="grid g4">
        <Stat label="Findings" value={String(summary?.totalFindings ?? 0)} />
        <Stat label="Launch blockers" value={String(scan.blockers)} />
        <Stat label="Auto-fixable" value={String(summary?.fixable ?? 0)} />
        <Stat label="Time to launch ready" value={summary?.estimatedTimeToLaunch ?? '—'} />
      </div>

      <h2>Categories</h2>
      <div className="grid g2">
        <div className="card">
          <RadarChart categories={categories.map((c) => ({ label: c.label, score: c.score }))} />
        </div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Score</th>
                <th>Weight</th>
                <th>Blockers</th>
              </tr>
            </thead>
            <tbody>
              {[...categories]
                .sort((a, b) => a.score - b.score)
                .map((c) => (
                  <tr key={c.category}>
                    <td>{c.label}</td>
                    <td style={{ width: 130 }}>
                      <Bar score={c.score} />
                    </td>
                    <td className="sub">{c.weight}</td>
                    <td>{c.blockers || '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Fix before launch</h2>
      {blockers.length === 0 ? (
        <div className="card">No launch blockers. The remaining findings are quality improvements.</div>
      ) : (
        <div className="card">
          <BlockerList blockers={blockers} />
        </div>
      )}

      <h2>Agent cost</h2>
      <div className="card">
        <div className="sub">
          Token and cost telemetry arrives from <code>shipready observe</code>. Point the CLI at the
          dashboard with <code>SHIPREADY_API_URL</code> to populate this.
        </div>
      </div>

      <h2>Trend</h2>
      <div className="card">
        <TrendsChart
          points={
            use(trendsPromise(projectId)) as unknown as { at: string; score: number }[]
          }
        />
      </div>

      <div className="footer">
        ShipReady · production readiness for AI-built software. Score 0-100, weighted across ten
        categories; blockers are findings that lose data, money or trust.
      </div>
    </div>
  );
}

function trendsPromise(projectId: string): Promise<{ at: string; score: number }[]> {
  return import('../lib/store.js').then((store) => store.trends(projectId, 60));
}

function verdictColour(verdict: string): string {
  if (verdict === 'PRODUCTION READY') return 'var(--ok)';
  if (verdict === 'READY WITH CAVEATS') return 'var(--warn)';
  if (verdict === 'NEEDS WORK') return 'var(--warn)';
  return 'var(--bad)';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function Bar({ score }: { score: number }) {
  const colour = score >= 85 ? 'var(--ok)' : score >= 65 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="bar">
      <div style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: colour }} />
    </div>
  );
}

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="wrap">
      <header>
        <h1>ShipReady</h1>
        <div className="sub">No scans for project {projectId} yet.</div>
      </header>
      <div style={{ height: 24 }} />
      <div className="card">
        <h3>Upload your first scan</h3>
        <p>
          From your repository, add the readiness gate to CI with <code>shipready init --ci</code>, or
          upload a report directly:
        </p>
        <pre className="mono" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8 }}>
{`curl -X POST http://localhost:3001/api/scan \\
  -H 'content-type: application/json' \\
  -d '{"projectId":"${projectId}","report":'$(shipready scan . --format json --quiet | tail -n +1)'}'`}
        </pre>
        <p className="sub">
          Or run <code>shipready scan .</code> in the repository and let the GitHub Action post the
          result.
        </p>
      </div>
    </div>
  );
}