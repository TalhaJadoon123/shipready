import { humanDuration } from '../scoring.js';
import type { CategoryScore, ProductionReadinessReport, Severity } from '../types.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: '#e5484d',
  high: '#f76b15',
  medium: '#f5d90a',
  low: '#0091ff',
  info: '#8b8d98',
};

const VERDICT_COLOUR: Record<string, string> = {
  'PRODUCTION READY': '#30a46c',
  'READY WITH CAVEATS': '#ffb224',
  'NEEDS WORK': '#f76b15',
  'NOT READY': '#e5484d',
};

/**
 * A self-contained HTML report.
 *
 * One file, no CDN, no build step: the output has to be openable from a
 * download directory or emailed to someone without a server. Charts are
 * hand-rolled SVG rather than a charting library, which is what keeps it
 * dependency-free and works offline.
 */
export function formatHtml(report: ProductionReadinessReport, options: { title?: string } = {}): string {
  const title = options.title ?? 'ShipReady Production Readiness Report';
  const sorted = [...report.categories].sort((a, b) => a.score - b.score);
  const blockers = report.topBlockers;
  const critical = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #12151a; --panel2: #171b21; --border: #23272e;
    --text: #e6e8eb; --muted: #8b8d98; --accent: #0091ff;
    --ok: #30a46c; --warn: #ffb224; --bad: #e5484d;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f8f9; --panel:#fff; --panel2:#f0f1f3; --border:#e2e4e7; --text:#0b0d10; --muted:#5d6068; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 32px 20px 80px;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header { margin-bottom: 32px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 36px 0 12px; font-weight: 600; }
  h3 { font-size: 16px; margin: 0 0 8px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .verdict { display: inline-block; padding: 5px 12px; border-radius: 6px; font-weight: 700; font-size: 13px; letter-spacing: 0.02em; color: #fff; }
  .grid { display: grid; gap: 12px; }
  .g4 { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .g2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .hero { display: flex; gap: 28px; align-items: center; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  .score { font-size: 54px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
  .grade { font-size: 20px; font-weight: 700; color: var(--muted); }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
  .stat-value { font-size: 24px; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { font-family: var(--mono); font-size: 12px; background: var(--panel2); padding: 1px 5px; border-radius: 4px; }
  .sev { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
  .pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 20px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
  .pill.blocker { color: #fff; background: #e5484d33; border-color: #e5484d66; }
  .pill.fix { color: #fff; background: #0091ff33; border-color: #0091ff66; }
  .blocker-item { border-left: 3px solid var(--bad); padding-left: 14px; margin-bottom: 18px; }
  .blocker-item.ok { border-color: var(--ok); }
  .muted { color: var(--muted); }
  .path { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--accent); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(report.project.type)} · ${report.project.totalLines.toLocaleString()} lines · ${new Date(report.generatedAt).toUTCString()}</div>
</header>

<div class="hero">
  <div>
    <div class="stat-label">Readiness score</div>
    <div class="score" style="color:${VERDICT_COLOUR[report.verdict] ?? 'var(--text)'}">${report.score}</div>
    <div class="grade">${esc(report.grade)} / 100</div>
  </div>
  <div style="flex:1; min-width:240px">
    <div class="stat-label">Verdict</div>
    <div style="margin:6px 0 12px"><span class="verdict" style="background:${VERDICT_COLOUR[report.verdict] ?? 'var(--muted)'}">${esc(report.verdict)}</span></div>
    ${scoreBarSvg(report.score)}
  </div>
</div>

<h2>Summary</h2>
<div class="grid g4">
  ${statCard('Total findings', String(report.summary.totalFindings))}
  ${statCard('Launch blockers', String(report.summary.blockers))}
  ${statCard('Auto-fixable', String(report.summary.fixable))}
  ${statCard('Time to launch ready', report.summary.estimatedTimeToLaunch)}
</div>

<h2>Category scores</h2>
<div class="grid g2">
  <div class="card">${radarSvg(sorted)}</div>
  <div class="card">
    <table>
      <thead><tr><th>Category</th><th>Score</th><th>Weight</th><th>Findings</th></tr></thead>
      <tbody>
      ${sorted
        .map(
          (cat) => `<tr>
            <td>${esc(cat.label)}${cat.blockers ? ` <span class="pill blocker">${cat.blockers} blocker</span>` : ''}</td>
            <td style="width:130px">${miniBar(cat.score)}</td>
            <td class="muted">${cat.weight}</td>
            <td class="muted">${cat.findingCount}</td>
          </tr>`,
        )
        .join('\n')}
      </tbody>
    </table>
  </div>
</div>

${
  blockers.length > 0
    ? `<h2>Fix before launch</h2>
${blockers
  .map(
    (b, i) => `<div class="blocker-item">
  <h3>${i + 1}. ${esc(b.title)} <span class="pill">${esc(b.severity)}</span> ${b.fixable ? '<span class="pill fix">auto-fixable</span>' : ''}</h3>
  <div class="path">${esc(b.path)}:${b.line}</div>
  <div class="muted" style="margin:6px 0">${esc(b.rationale)}</div>
  <div><strong>Fix:</strong> ${esc(b.remediation)}</div>
  <div class="sub">≈ ${humanDuration(b.effortMinutes)}</div>
</div>`,
  )
  .join('\n')}`
    : '<h2>Fix before launch</h2><div class="card"><strong>No launch blockers.</strong> The remaining findings are quality improvements, not things standing between you and real users.</div>'
}

<h2>Findings by severity</h2>
<div class="card">
${severityChart(report)}
</div>

<h2>High-severity detail (${critical.length})</h2>
<div class="card">
${
  critical.length > 0
    ? `<table>
<thead><tr><th></th><th>Finding</th><th>Location</th><th>Impact</th><th>Effort</th></tr></thead>
<tbody>
${critical
  .map(
    (f) => `<tr>
  <td style="width:20px"><span class="sev" style="background:${SEVERITY_COLOUR[f.severity]}"></span></td>
  <td><strong>${esc(f.title)}</strong><div class="sub">${esc(f.evidence.summary)}</div>
    ${
      f.compliance.length
        ? `<div style="margin-top:5px">${f.compliance.map((c) => `<span class="pill">${esc(c.framework)}${c.article ? ' ' + esc(c.article) : ''}</span>`).join(' ')}</div>`
        : ''
    }
  </td>
  <td class="path">${esc(f.location.path)}<br/>${f.location.startLine}</td>
  <td><span class="pill ${f.productionImpact === 'blocker' ? 'blocker' : ''}">${esc(f.productionImpact)}</span></td>
  <td class="muted">~${humanDuration(f.effortMinutes)}</td>
</tr>`,
  )
  .join('\n')}
</tbody></table>`
    : '<div class="muted">No critical or high-severity findings.</div>'
}
</div>

<details>
  <summary>All ${report.findings.length} findings</summary>
  <div class="card" style="margin-top:10px">
  <table>
    <thead><tr><th></th><th>Rule</th><th>Location</th><th>Category</th></tr></thead>
    <tbody>
    ${report.findings
      .map(
        (f) => `<tr>
      <td style="width:20px"><span class="sev" style="background:${SEVERITY_COLOUR[f.severity]}"></span></td>
      <td><strong>${esc(f.title)}</strong><div class="sub">${esc(f.remediation)}</div></td>
      <td class="path">${esc(f.location.path)}<br/>${f.location.startLine}</td>
      <td class="muted">${esc(f.category)}</td>
    </tr>`,
      )
      .join('\n')}
    </tbody>
  </table>
  </div>
</details>

<footer>
  Generated by ShipReady · ${new Date(report.generatedAt).toISOString()} · scan took ${report.durationMs} ms<br/>
  Re-run with <code>shipready scan . --compare</code>
</footer>
</div>
</body>
</html>`;
}

function statCard(label: string, value: string): string {
  return `<div class="card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div></div>`;
}

function scoreBarSvg(score: number): string {
  const w = 100;
  const filled = (score / 100) * w;
  const colour = score >= 85 ? 'var(--ok)' : score >= 65 ? 'var(--warn)' : 'var(--bad)';
  return `<svg viewBox="0 0 100 8" width="100%" height="8" preserveAspectRatio="none" role="img" aria-label="Score ${score} of 100">
    <rect width="100" height="8" rx="4" fill="var(--panel2)"/>
    <rect width="${filled}" height="8" rx="4" fill="${colour}"/>
  </svg>`;
}

function miniBar(score: number): string {
  const colour = score >= 85 ? 'var(--ok)' : score >= 65 ? 'var(--warn)' : 'var(--bad)';
  return `<svg viewBox="0 0 100 6" width="90" height="6" preserveAspectRatio="none">
    <rect width="100" height="6" rx="3" fill="var(--panel2)"/>
    <rect width="${score}" height="6" rx="3" fill="${colour}"/>
  </svg> <span style="font-family:var(--mono);font-size:12px">${score}</span>`;
}

/** Hand-rolled radar chart. Five axes is the useful maximum for this data. */
function radarSvg(categories: CategoryScore[]): string {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 40;
  const n = Math.min(categories.length, 10);
  const data = categories.slice(0, n);

  if (data.length < 3) {
    return '<div class="muted">Not enough categories for a radar view.</div>';
  }

  const point = (i: number, fraction: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / data.length - Math.PI / 2;
    return [cx + Math.cos(angle) * r * fraction, cy + Math.sin(angle) * r * fraction];
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const pts = data.map((_, i) => point(i, f).join(',')).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="var(--border)" stroke-width="1"/>`;
    })
    .join('\n');

  const axes = data
    .map((_, i) => {
      const [x, y] = point(i, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    })
    .join('\n');

  const values = data.map((cat, i) => point(i, Math.max(0.02, cat.score / 100)).join(',')).join(' ');
  const labels = data
    .map((cat, i) => {
      const [x, y] = point(i, 1.19);
      const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-size="9" fill="var(--muted)">${esc(cat.label.split(' ')[0] ?? cat.category)}</text>`;
    })
    .join('\n');

  const dots = data
    .map((cat, i) => {
      const [x, y] = point(i, Math.max(0.02, cat.score / 100));
      const colour = cat.score >= 85 ? 'var(--ok)' : cat.score >= 65 ? 'var(--warn)' : 'var(--bad)';
      return `<circle cx="${x}" cy="${y}" r="3" fill="${colour}"/>`;
    })
    .join('\n');

  return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:320px;display:block;margin:0 auto" role="img" aria-label="Category radar chart">
    <title>Production readiness by category</title>
    ${rings}
    ${axes}
    <polygon points="${values}" fill="var(--accent)" fill-opacity="0.18" stroke="var(--accent)" stroke-width="2"/>
    ${dots}
    ${labels}
  </svg>`;
}

function severityChart(report: ProductionReadinessReport): string {
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const counts = order.map((s) => ({ severity: s, n: report.summary.bySeverity[s] }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  const barH = 26;
  const gap = 8;
  const height = counts.length * (barH + gap);
  const labelW = 70;
  const chartW = 520;

  const bars = counts
    .map((c, i) => {
      const y = i * (barH + gap);
      const w = (c.n / max) * (chartW - labelW - 40);
      return `<text x="0" y="${y + barH / 2 + 4}" font-size="11" fill="var(--muted)">${c.severity}</text>
      <rect x="${labelW}" y="${y}" width="${chartW - labelW - 40}" height="${barH}" rx="4" fill="var(--panel2)"/>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${SEVERITY_COLOUR[c.severity]}"/>
      <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" font-size="11" fill="var(--text)" font-family="var(--mono)">${c.n}</text>`;
    })
    .join('\n');

  return `<svg viewBox="0 0 ${chartW} ${height}" width="100%" role="img" aria-label="Findings by severity">
    <title>Findings by severity</title>
    ${bars}
  </svg>`;
}