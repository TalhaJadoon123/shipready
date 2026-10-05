import type { ReactElement } from 'react';
import {
  currentDriver,
  listCompliance,
  listFindings,
  listInvoices,
  listTraces,
  latestScan,
  trends,
} from '../lib/store.js';
import {
  ActivityHeatmap,
  CategoryBars,
  CostChart,
  RadarChart,
  ScoreRing,
  SeverityBars,
  TrendChart,
  formatEffort,
  formatUsd,
  scoreColour,
  shortLabel,
  verdictTone,
} from '../components/charts.js';

/**
 * The dashboard.
 *
 * Server-rendered, so the first paint already contains real data. That matters
 * for a page whose entire purpose is answering "is this shippable?" -- an empty
 * page that fills in two seconds later reads as "no information", and the user
 * leaves.
 *
 * Layout follows the order a person actually asks the questions in: what is the
 * verdict, what is it made of, what do I fix first, what is the agent costing
 * me, and where does compliance stand.
 */
export const dynamic = 'force-dynamic';

interface CategoryView {
  label: string;
  score: number;
  blockers: number;
  findings: number;
  weight: number;
}

/**
 * Next requires a statically analysable prop type, and TypeScript cannot name
 * the return type of a component whose JSX references React's namespace.
 *
 * The annotation is not cosmetic: without it the declaration emits
 * `.pnpm/@types+react@18.3.31/...` into `dist/`, because @shipready/observer
 * pins React 18 while this package is on 19. That resolves on a machine with one
 * hoisted copy and fails on a clean install, which is exactly how it passed
 * locally and broke in CI.
 *
 * `ReactElement` is imported from `react` rather than spelled as
 * `React.JSX.Element`: the emitted declaration then refers to this package's own
 * React types instead of whichever version of @types/react pnpm resolved.
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const projectId = typeof params.project === 'string' ? params.project : 'acme-ai-dashboard';

  const [scan, points, traces, packs, invoices] = await Promise.all([
    latestScan(projectId),
    trends(projectId, 40),
    listTraces(projectId, 12),
    listCompliance(projectId, 5),
    listInvoices(projectId, 6),
  ]);

  const driver = currentDriver();

  if (!scan) return <EmptyState projectId={projectId} />;

  const report = scan.report as {
    categories?: { category: string; label: string; score: number; weight: number; findingCount: number; blockers: number }[];
    summary?: {
      estimatedTimeToLaunch: string;
      fixable: number;
      totalFindings: number;
      bySeverity: Record<string, number>;
      byImpact: Record<string, number>;
    };
    topBlockers?: {
      title: string;
      path: string;
      line: number;
      remediation: string;
      effortMinutes: number;
      productionImpact: string;
      severity: string;
    }[];
  };

  const categories: CategoryView[] = (report.categories ?? []).map((c) => ({
    label: c.label,
    score: c.score,
    blockers: c.blockers,
    findings: c.findingCount,
    weight: c.weight,
  }));

  const summary = report.summary ?? {
    estimatedTimeToLaunch: '—',
    fixable: 0,
    totalFindings: scan.findingsCount,
    bySeverity: {},
    byImpact: {},
  };
  const blockers = report.topBlockers ?? [];
  const tone = verdictTone(scan.verdict);

  // Cost across the trace window, so the tile matches the table underneath it.
  const traceCost = traces.reduce((sum, t) => sum + t.totalCostUsd, 0);
  const traceTokens = traces.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0);
  const traceErrors = traces.reduce((sum, t) => sum + t.errors, 0);
  const models = aggregateModels(traces);

  // Cost by day, derived from the trace timestamps.
  const costByDay = tracesToCostByDay(traces);
  const activity = tracesToActivity(traces);

  const delta = points.length > 1 ? points[points.length - 1]!.score - points[0]!.score : 0;
  const latest = latestPack(packs);
  const invoicePassRate = invoices.length
    ? Math.round((invoices.filter((i) => i.valid).length / invoices.length) * 100)
    : null;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span>
            ShipReady
            <small>v0.1</small>
          </span>
        </div>

        <nav className="nav">
          <span className="nav-label">Readiness</span>
          <a className="nav-item active" href="#top">
            <span className="ico">◉</span> Overview
          </a>
          <a className="nav-item" href="#blockers">
            <span className="ico">▲</span> Blockers
            {scan.blockers > 0 && <span className="count bad">{scan.blockers}</span>}
          </a>
          <a className="nav-item" href="#findings">
            <span className="ico">≡</span> All findings
            <span className="count">{summary.totalFindings}</span>
          </a>

          <span className="nav-label" style={{ marginTop: 14 }}>
            Agent
          </span>
          <a className="nav-item" href="#agent">
            <span className="ico">◆</span> Traces
            <span className="count">{traces.length}</span>
          </a>

          <span className="nav-label" style={{ marginTop: 14 }}>
            Compliance
          </span>
          <a className="nav-item" href="#compliance">
            <span className="ico">§</span> Packs
            {latest && latest.score < 85 && <span className="count">{latest.score}</span>}
          </a>
          <a className="nav-item" href="#invoices">
            <span className="ico">¢</span> Invoices
            {invoicePassRate !== null && <span className="count">{invoicePassRate}%</span>}
          </a>
        </nav>

        <div className="side-foot">
          <div>
            project <code>{projectId}</code>
          </div>
          <div style={{ marginTop: 4 }}>
            {scan.branch ?? 'main'} · {scan.commitSha?.slice(0, 7) ?? '—'}
          </div>
          <div style={{ marginTop: 4 }}>store: {driver}</div>
        </div>
      </aside>

      <main className="main" id="top">
        <div className="page-head">
          <div>
            <div className="crumb">
              <span>Production readiness</span>
              <span>·</span>
              <code>{projectId}</code>
            </div>
            <h1>{projectId}</h1>
          </div>
          <div className="chip-row">
            <span className="chip">
              scanned <b>{new Date(scan.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</b>
            </span>
            {delta !== 0 && (
              <span className={`chip ${delta > 0 ? 'ok' : 'bad'}`}>
                {delta > 0 ? '▲' : '▼'} <b>{delta > 0 ? '+' : ''}{delta}</b> since first scan
              </span>
            )}
            <span className="chip">
              {points.length} scan{points.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {/* ---------------------------------------------------------- hero */}
        <div className="hero">
          <ScoreRing score={scan.score} grade={scan.grade} />

          <div className="hero-copy">
            <span className={`verdict ${tone}`}>
              <i className="dot" />
              {scan.verdict}
            </span>
            <p>{verdictNarrative(scan.verdict, scan.blockers, blockers[0]?.title)}</p>
            <div className="hero-meta">
              <span>
                blockers <b>{scan.blockers}</b>
              </span>
              <span>
                findings <b>{summary.totalFindings}</b>
              </span>
              <span>
                auto-fixable <b>{summary.fixable}</b>
              </span>
              <span>
                to launch <b>{summary.estimatedTimeToLaunch}</b>
              </span>
            </div>
          </div>

          <div className="hero-side">
            {/* `summary.blockers`, not `topBlockers.length`: that list is deduped
                by rule and capped at five, so its length is a display budget, not
                a count. */}
            <div className="big-stat">
              <b style={{ color: scan.blockers > 0 ? 'var(--bad)' : 'var(--ok)' }}>{scan.blockers}</b>
              <span>launch blockers</span>
            </div>
            <div className="big-stat">
              <b>{summary.totalFindings}</b>
              <span>total findings</span>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- summary */}
        <section style={{ marginTop: 22 }}>
          <div className="grid g4">
            <Stat
              k="Findings"
              v={String(summary.totalFindings)}
              s={`${summary.bySeverity.critical ?? 0} critical · ${summary.bySeverity.high ?? 0} high`}
            />
            <Stat
              k="Launch blockers"
              v={String(scan.blockers)}
              s={scan.blockers === 0 ? 'nothing standing between you and launch' : 'fix these before inviting users'}
              tone={scan.blockers > 0 ? 'bad' : 'good'}
            />
            <Stat
              k="Auto-fixable"
              v={String(summary.fixable)}
              s="shipready fix generates working code"
              tone={summary.fixable > 0 ? 'warn' : undefined}
            />
            <Stat
              k="Time to launch ready"
              v={summary.estimatedTimeToLaunch}
              s="blockers only, at the estimate in each finding"
            />
          </div>
        </section>

        {/* ------------------------------------------------------ categories */}
        <section>
          <p className="section-label">Composition</p>
          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h2>Readiness by category</h2>
                <span className="hint">ringed = has blockers</span>
              </div>
              <RadarChart categories={categories} />
              <div className="legend">
                <span>
                  <i className="dot" style={{ background: 'var(--ok)' }} />
                  ≥ 85
                </span>
                <span>
                  <i className="dot" style={{ background: 'var(--warn)' }} />
                  65–84
                </span>
                <span>
                  <i className="dot" style={{ background: 'var(--bad)' }} />
                  &lt; 45
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Weighted categories</h2>
                <span className="hint">worst first</span>
              </div>
              <CategoryBars categories={categories} />
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- trend */}
        <section>
          <p className="section-label">Trend</p>
          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h2>Score over time</h2>
                <span className="hint">{points.length} scans</span>
              </div>
              <TrendChart points={points} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Findings by severity</h2>
                <span className="hint">across all findings</span>
              </div>
              <SeverityBars counts={summary.bySeverity} />
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- blockers */}
        <section id="blockers">
          <p className="section-label">Fix before launch</p>
          <div className="card flush">
            {blockers.length === 0 ? (
              <div className="empty">
                <div className="big">✓</div>
                No launch blockers. The remaining findings are quality improvements.
              </div>
            ) : (
              <>
                {scan.blockers > blockers.length && (
                  // Say so rather than letting five look like all of them.
                  <div
                    className="dim"
                    style={{ padding: '12px 18px 0', fontSize: 12.5 }}
                  >
                    Showing the {blockers.length} highest-impact of {scan.blockers}.{' '}
                    <code>shipready scan . --verbose</code> lists the rest.
                  </div>
                )}
                {blockers.map((b, i) => (
                <div className="blocker" key={`${b.path}:${b.line}:${i}`} style={{ padding: '15px 18px' }}>
                  <span className="n">{i + 1}</span>
                  <div>
                    <h4>{b.title}</h4>
                    <div className="where">
                      {b.path}:{b.line}
                    </div>
                    <div className="fix">{b.remediation}</div>
                    <div className="foot">
                      <span className={`pill ${b.severity}`}>{b.severity}</span>
                      <span className="chip">≈ {formatEffort(b.effortMinutes)}</span>
                      <span className="chip">losses data, money or trust</span>
                    </div>
                  </div>
                </div>
                ))}
              </>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ findings */}
        <section id="findings">
          <p className="section-label">All findings</p>
          <FindingsTable projectId={projectId} />
        </section>

        {/* --------------------------------------------------------- agent */}
        <section id="agent">
          <p className="section-label">Agent observability</p>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat k="Model spend" v={formatUsd(traceCost)} s={`across ${traces.length} traces`} />
            <Stat k="Tokens" v={formatTokens(traceTokens)} s="input + output" />
            <Stat
              k="Errors"
              v={String(traceErrors)}
              s={traceErrors === 0 ? 'no failures in this window' : 'see the traces below'}
              tone={traceErrors > 0 ? 'bad' : 'good'}
            />
            <Stat k="Models" v={String(models.length)} s={models.slice(0, 2).map((m) => m.model.split('/')[1]).join(', ')} />
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h2>Spend by day</h2>
                <span className="hint">red = over $1</span>
              </div>
              <CostChart days={costByDay} />
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Activity by run</h2>
                <span className="hint">one cell per trace</span>
              </div>
              <ActivityHeatmap buckets={activity} />
            </div>
          </div>

          <div className="card flush" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>Command</th>
                  <th className="num">Cost</th>
                  <th className="num">Tokens</th>
                  <th className="num">LLM</th>
                  <th className="num">Tools</th>
                  <th className="num">Err</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t) => (
                  <tr key={t.id}>
                    <td className="mono truncate" style={{ maxWidth: 380 }}>
                      {t.command}
                    </td>
                    <td className="num" style={{ color: t.totalCostUsd > 1 ? 'var(--bad)' : undefined }}>
                      {formatUsd(t.totalCostUsd)}
                    </td>
                    <td className="num">{formatTokens(t.inputTokens + t.outputTokens)}</td>
                    <td className="num">{t.llmCalls}</td>
                    <td className="num">{t.toolCalls}</td>
                    <td className="num" style={{ color: t.errors > 0 ? 'var(--bad)' : undefined }}>
                      {t.errors}
                    </td>
                    <td className="dim nowrap">
                      {new Date(t.startedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                  </tr>
                ))}
                {traces.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No traces yet. Run <code>shipready observe -- node your-agent.js</code>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* --------------------------------------------------- compliance */}
        <section id="compliance">
          <p className="section-label">Compliance</p>
          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h2>Documentation pack</h2>
                {latest && <span className="pill ok">{latest.score}/100</span>}
              </div>
              {latest ? (
                <>
                  <div className="cat-list" style={{ marginBottom: 14 }}>
                    {latest.frameworks.map((f) => (
                      <div className="cat-row" key={f}>
                        <span className="lbl" style={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: '0.06em' }}>
                          {f}
                        </span>
                        <div className="bar">
                          <span
                            style={{
                              width: `${Math.max(3, latest.score)}%`,
                              background: scoreColour(latest.score),
                            }}
                          />
                        </div>
                        <span className="n">{latest.documentCount} docs</span>
                      </div>
                    ))}
                  </div>
                  <p className="dim" style={{ fontSize: 12.5, margin: 0 }}>
                    {latest.company} · {latest.systemName} · {latest.jurisdiction}
                  </p>
                </>
              ) : (
                <div className="empty">
                  <div className="big">§</div>
                  No pack yet. Run <code>shipready comply init</code>.
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Outstanding gaps</h2>
                {latest && latest.gaps.length > 0 && <span className="pill critical">{latest.gaps.length}</span>}
              </div>
              {latest && latest.gaps.length > 0 ? (
                <div className="sev-list">
                  {(latest.gaps as { id: string; severity: string; message: string }[]).map((gap) => (
                    <div key={gap.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <span className={`pill ${gap.severity}`} style={{ marginTop: 1 }}>
                        {gap.severity.slice(0, 4)}
                      </span>
                      <div>
                        <div style={{ fontSize: 13 }}>{gap.message}</div>
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {gap.id}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <div className="big">✓</div>
                  No open gaps in the latest pack.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ invoices */}
        <section id="invoices">
          <p className="section-label">E-invoicing</p>
          <div className="card flush">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Issuer</th>
                  <th className="num">Total</th>
                  <th className="num">Score</th>
                  <th>Status</th>
                  <th>Validated</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">
                      {i.documentType.toUpperCase()} {i.number}
                    </td>
                    <td className="truncate" style={{ maxWidth: 260 }}>
                      {i.issuer || '—'}
                    </td>
                    <td className="num">{formatMoney(i.total, i.currency)}</td>
                    <td className="num" style={{ color: scoreColour(i.score) }}>
                      {i.score}
                    </td>
                    <td>
                      <span className={`pill ${i.valid ? 'ok' : 'critical'}`}>{i.valid ? 'valid' : 'invalid'}</span>
                    </td>
                    <td className="dim nowrap">
                      {new Date(i.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                  </tr>
                ))}
                {invoices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No invoices validated yet. Run <code>shipready validate invoice.xml</code>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="footer">
          <span>
            ShipReady · production readiness for AI-built software. Score 0–100, weighted across ten
            categories; blockers are findings that lose data, money or trust.
          </span>
          <span>
            <a href="https://github.com/shipreadyai/shipready">source</a> · MIT
          </span>
        </footer>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- components

function Stat({
  k,
  v,
  s,
  tone,
}: {
  k: string;
  v: string;
  s?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

/** The findings table, rendered from the denormalised rows the API serves. */
async function FindingsTable({ projectId }: { projectId: string }) {
  const findings = (await listFindings(projectId, undefined, 200)) as {
    id: number;
    title: string;
    ruleId: string;
    severity: string;
    category: string;
    path: string;
    line: number;
    effortMinutes: number;
    fixable: boolean;
  }[];

  if (findings.length === 0) return <div className="card empty">No findings recorded.</div>;

  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));

  return (
    <div className="card flush">
      <table>
        <thead>
          <tr>
            <th style={{ width: 78 }}>Severity</th>
            <th>Finding</th>
            <th style={{ width: 150 }}>Category</th>
            <th style={{ width: 240 }}>Location</th>
            <th className="num" style={{ width: 80 }}>
              Effort
            </th>
            <th style={{ width: 74 }} />
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 40).map((f) => (
            <tr key={f.id}>
              <td>
                <span className={`pill ${f.severity}`}>{f.severity}</span>
              </td>
              <td>
                <div style={{ fontWeight: 500 }}>{f.title}</div>
                <div className="dim mono" style={{ fontSize: 11 }}>
                  {f.ruleId}
                </div>
              </td>
              <td className="dim">{shortLabel(f.category, 18)}</td>
              <td className="mono dim truncate" style={{ maxWidth: 240 }}>
                {f.path}:{f.line}
              </td>
              <td className="num dim">≈ {formatEffort(f.effortMinutes)}</td>
              <td>{f.fixable && <span className="pill accent">fixable</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > 40 && (
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }} className="dim">
          …and {sorted.length - 40} more. Run <code>shipready scan . --verbose</code> for the full list.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- helpers

function verdictNarrative(verdict: string, blockers: number, worst?: string): string {
  if (blockers === 0 && verdict === 'PRODUCTION READY') {
    return 'No launch blockers. Nothing found here would lose data, money or trust. What remains is polish, and polish can wait.';
  }
  if (verdict === 'READY WITH CAVEATS') {
    return `${blockers} issue${blockers === 1 ? '' : 's'} worth knowing about before you invite users. None of them lose data, so this is a judgement call rather than a stop sign.`;
  }
  if (verdict === 'NEEDS WORK') {
    return `Real risk. ${blockers} issue${blockers === 1 ? '' : 's'} could cost you a customer${worst ? ` — starting with ${worst.toLowerCase()}` : ''}. Work them before launch, not after.`;
  }
  return `Do not ship this to anyone who matters. ${blockers} issue${blockers === 1 ? '' : 's'} stand between this codebase and real users.`;
}

function aggregateModels(
  traces: readonly { summary: Record<string, unknown> }[],
): { model: string; calls: number; costUsd: number }[] {
  const acc = new Map<string, { calls: number; costUsd: number }>();
  for (const t of traces) {
    const byModel = (t.summary as { byModel?: Record<string, { calls: number; costUsd: number }> }).byModel ?? {};
    for (const [model, m] of Object.entries(byModel)) {
      const cur = acc.get(model) ?? { calls: 0, costUsd: 0 };
      acc.set(model, { calls: cur.calls + m.calls, costUsd: cur.costUsd + m.costUsd });
    }
  }
  return [...acc.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

function tracesToCostByDay(traces: readonly { startedAt: Date; totalCostUsd: number }[]) {
  const byDay = new Map<string, number>();
  for (const t of traces) {
    const day = new Date(t.startedAt).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + t.totalCostUsd);
  }
  return [...byDay.entries()].sort().map(([day, costUsd]) => ({ day, costUsd }));
}

function tracesToActivity(traces: readonly { llmCalls: number; toolCalls: number; errors: number; summary: Record<string, unknown> }[]) {
  return traces.map((t) => ({
    llm: t.llmCalls,
    tool: t.toolCalls,
    network: ((t.summary as { hosts?: string[] }).hosts ?? []).length,
    error: t.errors,
  }));
}

function latestPack<T extends { createdAt: Date | string }>(packs: readonly T[]): T | null {
  if (packs.length === 0) return null;
  // Newest, not highest-scoring: a later pack that scores worse is still the
  // one that describes where the project actually stands today.
  return [...packs].sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)))[0]!;
}

/**
 * Money with the right symbol.
 *
 * `formatUsd` is the agent-spend formatter and hardcodes `$`, which is right for
 * model pricing and wrong for an invoice in BRL. Showing "R$" beats showing a
 * dollar sign on a Brazilian tax document.
 */
function formatMoney(amount: number, currency: string): string {
  if (currency === 'USD') return formatUsd(amount);
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span>
            ShipReady
            <small>v0.1</small>
          </span>
        </div>
      </aside>
      <main className="main">
        <div className="page-head">
          <div>
            <div className="crumb">
              <span>Production readiness</span>
            </div>
            <h1>No scans for {projectId} yet</h1>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Get your first scan</h3>
          <p className="muted">
            Add the readiness gate to CI, or upload a report you already have:
          </p>
          <pre>
            <span className="cmd">shipready</span> init <span className="arg">--ci</span>{'\n'}
            <span className="cmd">shipready</span> scan <span className="arg">.</span>{'\n'}
            <span className="cmd">pnpm --filter @shipready/web</span> <span className="arg">seed</span> <span className="dim"># or seed demo data</span>
          </pre>
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Seeded demo data is generated by real scans of a synthetic repository, so the trend is
            genuine rather than fabricated.
          </p>
        </div>
      </main>
    </div>
  );
}
