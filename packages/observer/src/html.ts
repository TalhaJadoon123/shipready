import { htmlEscape } from './util.js';
import { humanDuration } from './util.js';
import { humanUsd, tokens } from './util.js';
import type { Trace, TraceEvent } from './types.js';
import { MODEL_PRICES } from './pricing.js';

/**
 * HTML trace report.
 *
 * One file, no CDN, no build step, opens offline. Charts are hand-rolled SVG
 * for the same reason the readiness report is: a report you cannot open without
 * a network is a report nobody opens.
 *
 * The four questions it answers, in order: how much did this cost, where did
 * the tokens go, what did the agent actually do, and what went wrong.
 */
export function renderTraceReport(trace: Trace, options: { title?: string } = {}): string {
  const s = trace.summary;
  const title = options.title ?? `Agent trace ${s.id.slice(0, 8)}`;
  const llmEvents = trace.events.filter((e) => e.kind === 'llm') as Extract<TraceEvent, { kind: 'llm' }>[];
  const errors = trace.events.filter((e) => e.kind === 'error') as Extract<TraceEvent, { kind: 'error' }>[];
  const hosts = dedupe(
    trace.events.filter((e) => e.kind === 'network').map((e) => (e as Extract<TraceEvent, { kind: 'network' }>).host),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
  :root { --bg:#0b0d10; --panel:#12151a; --panel2:#171b21; --border:#23272e; --text:#e6e8eb; --muted:#8b8d98;
          --ok:#30a46c; --warn:#ffb224; --bad:#e5484d; --accent:#0091ff; --mono: ui-monospace, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: light) { :root { --bg:#f7f8f9; --panel:#fff; --panel2:#f0f1f3; --border:#e2e4e7; --text:#0b0d10; --muted:#5d6068; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:32px 20px 80px; }
  .wrap { max-width:1100px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:34px 0 12px; font-weight:600; }
  h3 { font-size:15px; margin:0 0 8px; }
  .sub { color:var(--muted); font-size:13px; }
  .grid { display:grid; gap:12px; }
  .g4 { grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); }
  .g2 { grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); }
  .card { background:var(--panel); border:1px solid solid; border:1px solid var(--border); border-radius:10px; padding:16px; }
  .stat-label { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .stat-value { font-size:26px; font-weight:700; margin-top:2px; }
  .stat-value.big { font-size:34px; }
  code, .mono { font-family:var(--mono); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--border); }
  td { padding:9px 10px; border-bottom:1px solid var(--border); }
  tr:last-child td { border-bottom:none; }
  .pill { display:inline-block; font-size:11px; padding:1px 7px; border-radius:20px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .pill.ok { color:var(--ok); border-color:var(--ok); } .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.bad { color:var(--bad); border-color:var(--bad); }
  .bar { height:8px; border-radius:4px; background:var(--panel2); overflow:hidden; }
  .bar > div { height:100%; border-radius:4px; }
  .timeline { position:relative; height:70px; background:var(--panel2); border-radius:6px; margin:10px 0 4px; }
  .lane { position:absolute; height:10px; border-radius:3px; opacity:.85; }
  .anom { border-left:3px solid var(--warn); padding:8px 12px; margin-bottom:8px; background:var(--panel2); border-radius:0 6px 6px 0; }
  .anom.critical { border-left-color:var(--bad); } .anom.info { border-left-color:var(--accent); }
  .empty { color:var(--muted); font-style:italic; }
  .err-item { border-left:3px solid var(--bad); padding-left:12px; margin-bottom:10px; }
  footer { margin-top:46px; padding-top:16px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
  details { margin-top:8px; } summary { cursor:pointer; color:var(--accent); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${htmlEscape(title)}</h1>
  <div class="sub">
    <code>${htmlEscape(s.command)}</code> &middot; ${humanDuration(s.durationMs)} &middot;
    exit ${s.exitCode ?? 'n/a'} &middot; ${new Date(s.startedAt).toUTCString()}
  </div>
</header>

${s.costComplete ? '' : '<div class="anom info"><strong>Cost is incomplete.</strong> At least one model was not in the price catalogue, so its cost is recorded as zero rather than guessed. A wrong number is worse than no number.</div>'}

<h2>Cost and tokens</h2>
<div class="grid g4">
  <div class="card"><div class="stat-label">Total cost</div><div class="stat-value big">${humanUsd(s.totalCostUsd)}</div></div>
  <div class="card"><div class="stat-label">Input tokens</div><div class="stat-value">${tokens(s.totalInputTokens)}</div></div>
  <div class="card"><div class="stat-label">Output tokens</div><div class="stat-value">${tokens(s.totalOutputTokens)}</div></div>
  <div class="card"><div class="stat-label">LLM calls</div><div class="stat-value">${s.llmCalls}</div></div>
</div>

<h2>Cost by model</h2>
<div class="card">
${
  Object.keys(s.byModel).length === 0
    ? '<div class="empty">No model calls were observed.</div>'
    : `<table>
<thead><tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cost</th><th>Share</th></tr></thead>
<tbody>
${Object.entries(s.byModel)
  .sort((a, b) => b[1].costUsd - a[1].costUsd)
  .map(([model, m]) => {
    const pct = s.totalCostUsd > 0 ? (m.costUsd / s.totalCostUsd) * 100 : 0;
    return `<tr>
  <td class="mono">${htmlEscape(model)} ${m.priced ? '' : '<span class="pill warn">unpriced</span>'}</td>
  <td>${m.calls}</td>
  <td>${tokens(m.inputTokens)}</td>
  <td>${tokens(m.outputTokens)}</td>
  <td>${m.priced ? humanUsd(m.costUsd) : 'unknown'}</td>
  <td style="width:140px"><div class="bar"><div style="width:${pct.toFixed(1)}%;background:var(--accent)"></div></div>
    <span class="sub">${pct.toFixed(0)}%</span></td>
</tr>`;
  })
  .join('\n')}
</tbody></table>`
}
</div>

<h2>Token usage over time</h2>
<div class="card">
${renderTokenTimeline(llmEvents, s.durationMs)}
</div>

<h2>Tool calls</h2>
<div class="grid g2">
  <div class="card">
${
  Object.keys(s.toolDistribution).length === 0
    ? '<div class="empty">No tool calls observed.</div>'
    : `<table><thead><tr><th>Tool</th><th>Calls</th><th>Share</th></tr></thead><tbody>
${Object.entries(s.toolDistribution)
  .sort((a, b) => b[1] - a[1])
  .map(
    ([tool, count]) => `<tr>
  <td class="mono">${htmlEscape(tool)}</td>
  <td>${count}</td>
  <td style="width:120px"><div class="bar"><div style="width:${((count / s.toolCalls) * 100).toFixed(0)}%;background:var(--accent)"></div></div></td>
</tr>`,
  )
  .join('\n')}
</tbody></table>`
}
  </div>
  <div class="card">
    <h3>Activity heatmap</h3>
${renderHeatmap(trace.events, s.durationMs)}
  </div>
</div>

<h2>Network</h2>
<div class="card">
${
  hosts.length === 0
    ? '<div class="empty">No outbound requests observed.</div>'
    : `<p class="sub">${hosts.length} distinct host(s):</p><p>${hosts.map((h) => `<span class="pill mono">${htmlEscape(h)}</span>`).join(' ')}</p>`
}
</div>

<h2>Anomalies</h2>
<div class="card">
${
  s.anomalies.length === 0
    ? '<div class="empty">Nothing unusual. No cost spikes, no unexpected hosts, no privilege escalation.</div>'
    : s.anomalies
        .map(
          (a) => `<div class="anom ${a.severity}">
  <strong>${htmlEscape(a.kind)}</strong> &middot; ${a.severity}
  <div>${htmlEscape(a.message)}</div>
  <div class="sub mono">${new Date(a.ts).toISOString()}</div>
</div>`,
        )
        .join('\n')
}
</div>

${
  errors.length > 0
    ? `<h2>Errors (${errors.length})</h2>
<div class="card">
${errors
  .slice(0, 20)
  .map(
    (e) => `<div class="err-item">
  <div><strong>${htmlEscape(e.message)}</strong>${e.fatal ? ' <span class="pill bad">fatal</span>' : ''}</div>
  <div class="sub mono">+${(e.offsetMs / 1000).toFixed(1)}s${e.stack ? `<pre style="overflow-x:auto;color:var(--muted)">${htmlEscape(e.stack.slice(0, 400))}</pre>` : ''}</div>
</div>`,
  )
  .join('\n')}
</div>`
    : ''
}

<details>
  <summary>All ${trace.events.length} events</summary>
  <div class="card" style="margin-top:10px">
  <table>
    <thead><tr><th>#</th><th>At</th><th>Kind</th><th>Name</th><th>Duration</th><th>Detail</th></tr></thead>
    <tbody>
${trace.events
  .map(
    (e) => `<tr>
  <td class="sub">${e.seq}</td>
  <td class="sub mono">+${(e.offsetMs / 1000).toFixed(2)}s</td>
  <td><span class="pill">${e.kind}</span></td>
  <td class="mono">${htmlEscape(e.name)}</td>
  <td class="sub">${e.durationMs !== undefined ? `${e.durationMs} ms` : ''}</td>
  <td class="sub mono">${htmlEscape(summariseEvent(e))}</td>
</tr>`,
  )
  .join('\n')}
    </tbody>
  </table>
  </div>
</details>

<footer>
  Generated by ShipReady observer &middot; ${MODEL_PRICES.length} models priced (as of ${MODEL_PRICES[0]?.asOf ?? 'n/a'}) &middot;
  prompts and responses are hashed, not stored, unless \`--capture-content\` was passed
</footer>
</div>
</body>
</html>`;
}

/** Token usage as a bar per call, positioned on the trace's real timeline. */
function renderTokenTimeline(
  events: readonly Extract<TraceEvent, { kind: 'llm' }>[],
  totalMs: number,
): string {
  if (events.length === 0) return '<div class="empty">No model calls to plot.</div>';
  const max = Math.max(...events.map((e) => e.inputTokens + e.outputTokens), 1);
  const width = totalMs > 0 ? totalMs : 1;

  const bars = events
    .map((e) => {
      const left = (e.offsetMs / width) * 100;
      const w = Math.max(0.8, ((e.durationMs ?? 100) / width) * 100);
      const h = Math.max(6, ((e.inputTokens + e.outputTokens) / max) * 52);
      const colour = e.costUsd > 0.05 ? 'var(--bad)' : e.costUsd > 0.01 ? 'var(--warn)' : 'var(--accent)';
      const title = `${e.model}: ${tokens(e.inputTokens)} in / ${tokens(e.outputTokens)} out, ${humanUsd(e.costUsd)}, ${e.durationMs ?? 0}ms`;
      return `<div class="lane" style="left:${Math.min(99, left).toFixed(2)}%;width:${Math.min(99.5 - left, w).toFixed(2)}%;height:${h}px;background:${colour}" title="${htmlEscape(title)}"></div>`;
    })
    .join('\n');

  return `<div class="timeline">${bars}</div>
<p class="sub">Bar height is total tokens, width is latency, position is when it started. Hover for the breakdown.</p>`;
}

/** One row per second of the trace, coloured by what was happening. */
function renderHeatmap(events: readonly TraceEvent[], totalMs: number): string {
  if (events.length === 0) return '<div class="empty">Nothing to plot.</div>';
  const seconds = Math.max(1, Math.min(120, Math.ceil(totalMs / 1000)));
  const perSecond: number[][] = Array.from({ length: seconds }, () => [0, 0, 0, 0]);

  for (const event of events) {
    const second = Math.min(seconds - 1, Math.floor(event.offsetMs / 1000));
    const bucket = perSecond[second]!;
    switch (event.kind) {
      case 'llm':
        bucket[0]!++;
        break;
      case 'tool':
        bucket[1]!++;
        break;
      case 'network':
        bucket[2]!++;
        break;
      case 'error':
        bucket[3]!++;
        break;
      default:
        break;
    }
  }
  const max = Math.max(
    1,
    ...perSecond.map((b) => (b[0] ?? 0) + (b[1] ?? 0) + (b[2] ?? 0) + (b[3] ?? 0)),
  );

  const cells = perSecond
    .map((bucket) => {
      // Destructure once: the buckets are fixed-length and `noUncheckedIndexedAccess`
      // would otherwise require a non-null assertion at every read.
      const [llm = 0, tool = 0, net = 0, err = 0] = bucket;
      const total = llm + tool + net + err;
      if (total === 0) return '<div class="lane" style="position:static;width:100%;height:8px;background:var(--border)"></div>';
      const intensity = total / max;
      const dominant =
        llm >= tool && llm >= net && llm >= err
          ? 'var(--accent)'
          : tool >= net && tool >= err
            ? 'var(--ok)'
            : net >= err
              ? 'var(--warn)'
              : 'var(--bad)';
      const title = `+${total}s: ${llm} llm, ${tool} tool, ${net} net, ${err} err`;
      return `<div class="lane" style="position:static;width:100%;height:8px;background:${dominant};opacity:${(0.35 + intensity * 0.65).toFixed(2)}" title="${title}"></div>`;
    })
    .join('');

  return `<div class="grid" style="grid-template-columns:repeat(${seconds > 30 ? 'auto-fill' : 'repeat(auto-fill, minmax(14px, 1fr))'})">${cells}</div>
<p class="sub">One cell per second. Blue is model calls, green tools, yellow network, red errors.</p>`;
}

function summariseEvent(event: TraceEvent): string {
  switch (event.kind) {
    case 'llm':
      return `${tokens(event.inputTokens)} in / ${tokens(event.outputTokens)} out${event.costPriced ? ` / ${humanUsd(event.costUsd)}` : ' / cost unknown'}`;
    case 'tool':
      return `${event.success ? 'ok' : 'failed'} ${event.argumentsHash.slice(0, 8)}`;
    case 'file':
      return `${event.operation} ${event.bytes}B`;
    case 'network':
      return `${event.method} ${event.status ?? '-'} ${event.responseBytes ?? 0}B`;
    case 'decision':
      return event.decision;
    case 'error':
      return event.message;
    default:
      return '';
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}