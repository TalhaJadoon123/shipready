/**
 * Charts, hand-rolled SVG.
 *
 * A charting library would be several hundred kilobytes to draw three shapes.
 * These are a ring, a radar and a line: not enough to justify a dependency
 * tree in a review, and hand-rolled means every pixel is deliberate.
 *
 * Everything is pure server-rendered SVG, so the first paint already contains
 * the chart rather than a spinner.
 */

import type { JSX } from 'react';

/**
 * Every component below returns `ReactElement` explicitly.
 *
 * Without the annotation TypeScript infers the return type and emits it into
 * the declaration file, where the JSX namespace it references resolves against
 * whichever copy of @types/react the package manager hoisted. Locally that is
 * one copy and the build passes; on a clean install it can be two, and the
 * emitted reference stops being portable. This cost a CI run and a fix to the
 * dashboard component, so the remaining seven are annotated rather than waiting
 * for the same failure to find them one at a time.
 */

export interface RadarDatum {
  label: string;
  score: number;
  blockers?: number;
}

export interface TrendPoint {
  at: string;
  score: number;
  blockers: number;
}

/** Colour for a 0-100 score. Consistent everywhere the number appears. */
export function scoreColour(score: number): string {
  if (score >= 85) return 'var(--ok)';
  if (score >= 65) return 'var(--warn)';
  if (score >= 45) return '#f28a44';
  return 'var(--bad)';
}

export function verdictTone(verdict: string): string {
  if (verdict === 'PRODUCTION READY') return 'ready';
  if (verdict === 'READY WITH CAVEATS') return 'caveats';
  if (verdict === 'NEEDS WORK') return 'work';
  return 'blocked';
}

/**
 * The score ring.
 *
 * A ring rather than a bar because the number is the product: it should be the
 * first thing on the screen and the thing your eye returns to. The tick marks
 * at the verdict boundaries turn it into an instrument rather than a gauge.
 */
export function ScoreRing({ score, grade }: { score: number; grade: string }): JSX.Element {
  const size = 148;
  const stroke = 11;
  const radius = (size - stroke) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const colour = scoreColour(score);

  // Verdict boundaries at 45, 65 and 85, so the ring reads against the bands.
  const tick = (value: number): { x: number; y: number } => {
    const angle = (value / 100) * 2 * Math.PI - Math.PI / 2;
    return { x: size / 2 + Math.cos(angle) * radius, y: size / 2 + Math.sin(angle) * radius };
  };

  return (
    <div className="score-ring">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Readiness score ${score} of 100, grade ${grade}`}>
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.65" />
            <stop offset="100%" stopColor={colour} />
          </linearGradient>
        </defs>

        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />

        {/* Verdict boundaries. */}
        {[45, 65, 85].map((value) => {
          const { x, y } = tick(value);
          return <circle key={value} cx={x} cy={y} r="2" fill="var(--surface-3)" stroke="var(--border-strong)" strokeWidth="1" />;
        })}

        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="num">
        <b style={{ color: colour }}>{score}</b>
        <span>
          grade {grade} / 100
        </span>
      </div>
    </div>
  );
}

/**
 * Readiness by category.
 *
 * A radar rather than a bar chart because the question is "is this balanced?".
 * A codebase can score 90 with one category at 20, and a bar chart hides that
 * while a radar makes it the most obvious thing on the screen.
 */
export function RadarChart({ categories }: { categories: RadarDatum[] }): JSX.Element {
  if (categories.length < 3) {
    return <div className="empty">Not enough categories for a radar view.</div>;
  }

  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 52;
  const n = categories.length;

  const point = (i: number, fraction: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * r * fraction, cy + Math.sin(angle) * r * fraction];
  };

  const rings = [0.25, 0.5, 0.75, 1].map((f) => {
    const points = categories.map((_, i) => point(i, f).join(',')).join(' ');
    return <polygon key={f} points={points} fill="none" stroke="var(--border)" strokeWidth="1" />;
  });

  const axes = categories.map((_, i) => {
    const [x, y] = point(i, 1);
    return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth="1" />;
  });

  const values = categories.map((c, i) => point(i, Math.max(0.02, c.score / 100)).join(',')).join(' ');

  const labels = categories.map((c, i) => {
    const [x, y] = point(i, 1.26);
    const anchor = Math.abs(x - cx) < 10 ? 'middle' : x > cx ? 'start' : 'end';
    return (
      <text key={c.label} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fontSize="10.5" fill="var(--text-dim)">
        {shortLabel(c.label)}
      </text>
    );
  });

  const dots = categories.map((c, i) => {
    const [x, y] = point(i, Math.max(0.02, c.score / 100));
    return (
      <g key={c.label}>
        {/* A blocker category gets a ring: the radar shows the shape, the ring
            marks where a launch would actually be stopped. */}
        {(c.blockers ?? 0) > 0 && (
          <circle cx={x} cy={y} r="6.5" fill="none" stroke="var(--bad)" strokeWidth="1.25" opacity="0.6" />
        )}
        <circle cx={x} cy={y} r="3.25" fill={scoreColour(c.score)} stroke="var(--surface)" strokeWidth="1.5" />
      </g>
    );
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: 340, display: 'block', margin: '0 auto' }} role="img" aria-label="Production readiness by category">
      <title>Production readiness by category</title>
      {rings}
      {axes}
      <polygon points={values} fill="var(--accent)" fillOpacity="0.16" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {dots}
      {labels}
    </svg>
  );
}

/** The score over time, with a shaded area and a verdict threshold line. */
export function TrendChart({ points }: { points: TrendPoint[] }): JSX.Element {
  if (points.length < 2) {
    return <div className="empty">Two or more scans are needed to show a trend.</div>;
  }

  const width = 620;
  const height = 168;
  const padX = 6;
  const padTop = 10;
  const padBottom = 22;

  // Fixed 0-100 domain: a truncated axis exaggerates a 3-point improvement,
  // which is exactly the kind of chart that gets a tool dismissed as alarmist.
  const y = (score: number): number =>
    padTop + (1 - Math.max(0, Math.min(100, score)) / 100) * (height - padTop - padBottom);
  const x = (i: number): number => padX + (i / (points.length - 1)) * (width - padX * 2);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  const area = `${padX},${height - padBottom} ${line} ${x(points.length - 1).toFixed(1)},${height - padBottom}`;

  const last = points[points.length - 1]!;
  const first = points[0]!;
  const delta = last.score - first.score;

  const gridlines = [0, 25, 50, 75, 100].map((v) => (
    <g key={v}>
      <line x1={padX} y1={y(v)} x2={width - padX} y2={y(v)} stroke="var(--border)" strokeWidth="1" opacity={v % 50 === 0 ? 0.9 : 0.45} />
      <text x={padX + 2} y={y(v) - 3} fontSize="9" fill="var(--text-dim)" fontFamily="var(--mono)">
        {v}
      </text>
    </g>
  ));

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`Readiness trend, ${first.score} to ${last.score}`} style={{ display: 'block' }}>
        {/* A template string, not interpolation: React renders every child of a
            <title> as text and cannot serialise an array of them. */}
        <title>{`Readiness from ${first.score} to ${last.score} over ${points.length} scans`}</title>
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridlines}
        {/* The 65 line is the "ship it" boundary, so it is drawn on the chart. */}
        <line x1={padX} y1={y(65)} x2={width - padX} y2={y(65)} stroke="var(--ok)" strokeWidth="1" strokeDasharray="4 4" opacity="0.55" />

        <polygon points={area} fill="url(#trendFill)" />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />

        {points.map((p, i) => (
          <circle
            key={p.at}
            cx={x(i)}
            cy={y(p.score)}
            r={i === points.length - 1 ? 4.5 : 2.75}
            fill={scoreColour(p.score)}
            stroke="var(--surface)"
            strokeWidth="1.5"
          />
        ))}

        <text x={padX} y={height - 6} fontSize="9.5" fill="var(--text-dim)" fontFamily="var(--mono)">
          {formatDay(first.at)}
        </text>
        <text x={width - padX} y={height - 6} fontSize="9.5" fill="var(--text-dim)" textAnchor="end" fontFamily="var(--mono)">
          {formatDay(last.at)}
        </text>
      </svg>

      <div className="legend">
        <span>
          <i className="dot" style={{ background: delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--bad)' : 'var(--text-dim)' }} />
          {delta > 0 ? '+' : ''}
          {delta} points over {points.length} scans
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--ok)' }} />
          65 = ship it
        </span>
      </div>
    </div>
  );
}

/** Horizontal severity distribution. */
export function SeverityBars({ counts }: { counts: Record<string, number> }): JSX.Element {
  const order = ['critical', 'high', 'medium', 'low', 'info'] as const;
  const total = order.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
  if (total === 0) return <div className="empty">No findings.</div>;
  const max = Math.max(...order.map((k) => counts[k] ?? 0), 1);
  const colour: Record<string, string> = {
    critical: 'var(--bad)',
    high: '#f28a44',
    medium: 'var(--warn)',
    low: 'var(--cyan)',
    info: 'var(--text-dim)',
  };

  return (
    <div className="sev-list">
      {order.map((key) => {
        const n = counts[key] ?? 0;
        return (
          <div className="sev-row" key={key}>
            <span className="lbl" style={{ color: colour[key] }}>
              {key}
            </span>
            <div className="bar">
              <span style={{ width: `${(n / max) * 100}%`, background: colour[key] }} />
            </div>
            <span className="n">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A compact per-category bar list, sorted worst first. */
export function CategoryBars({ categories }: { categories: RadarDatum[] }): JSX.Element {
  const sorted = [...categories].sort((a, b) => a.score - b.score);
  return (
    <div className="cat-list">
      {sorted.map((c) => (
        <div className="cat-row" key={c.label}>
          <span className="lbl">
            {shortLabel(c.label, 20)}
            {(c.blockers ?? 0) > 0 && (
              <span className="pill critical" style={{ padding: '0 6px', fontSize: 9.5 }}>
                {c.blockers} blocker{(c.blockers ?? 0) === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <div className="bar">
            <span style={{ width: `${Math.max(2, c.score)}%`, background: scoreColour(c.score) }} />
          </div>
          <span className="n" style={{ color: scoreColour(c.score) }}>
            {c.score}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Activity heatmap: one cell per interval, coloured by what was happening. */
export function ActivityHeatmap({
  buckets,
}: {
  buckets: { llm: number; tool: number; network: number; error: number }[];
}): JSX.Element {
  if (buckets.length === 0) return <div className="empty">No activity recorded.</div>;
  const max = Math.max(1, ...buckets.map((b) => b.llm + b.tool + b.network + b.error));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(buckets.length, 40)}, 1fr)`, gap: 3 }}>
        {buckets.map((b, i) => {
          const total = b.llm + b.tool + b.network + b.error;
          const dominant =
            total === 0
              ? 'var(--surface-2)'
              : b.error >= b.llm && b.error >= b.tool && b.error >= b.network
                ? 'var(--bad)'
                : b.llm >= b.tool && b.llm >= b.network
                  ? 'var(--accent)'
                  : b.tool >= b.network
                    ? 'var(--ok)'
                    : 'var(--warn)';
          const opacity = total === 0 ? 1 : 0.35 + (total / max) * 0.65;
          return (
            <div
              key={i}
              title={
                total === 0
                  ? 'idle'
                  : `${b.llm} model, ${b.tool} tool, ${b.network} net, ${b.error} err`
              }
              style={{ height: 22, borderRadius: 4, background: dominant, opacity }}
            />
          );
        })}
      </div>
      <div className="legend">
        <span>
          <i className="dot" style={{ background: 'var(--accent)' }} />
          model
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--ok)' }} />
          tool
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--warn)' }} />
          network
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--bad)' }} />
          error
        </span>
      </div>
    </div>
  );
}

/** A cost-per-day column chart. */
export function CostChart({ days }: { days: { day: string; costUsd: number }[] }): JSX.Element {
  if (days.length === 0) return <div className="empty">No cost recorded yet.</div>;
  const max = Math.max(...days.map((d) => d.costUsd), 0.0001);
  const width = 620;
  const height = 120;
  const gap = 4;
  const barWidth = (width - gap * (days.length - 1)) / days.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Cost by day" style={{ display: 'block' }}>
      <title>Model spend by day</title>
      {days.map((d, i) => {
        const h = Math.max(2, (d.costUsd / max) * (height - 18));
        const over = d.costUsd > 1;
        return (
          <g key={d.day}>
            <rect
              x={i * (barWidth + gap)}
              y={height - h}
              width={barWidth}
              height={h}
              rx="3"
              fill={over ? 'var(--bad)' : 'var(--accent)'}
              opacity="0.85"
            />
            <title>{`${d.day}: $${d.costUsd.toFixed(4)}`}</title>
          </g>
        );
      })}
      <text x={0} y={height - 3} fontSize="9.5" fill="var(--text-dim)" fontFamily="var(--mono)">
        {days[0]!.day}
      </text>
      <text x={width} y={height - 3} fontSize="9.5" fill="var(--text-dim)" textAnchor="end" fontFamily="var(--mono)">
        {days[days.length - 1]!.day}
      </text>
    </svg>
  );
}

/** `error-handling` -> `Error handling`. Keeps radar labels readable. */
export function shortLabel(label: string, max = 16): string {
  const words = label.replace(/-/g, ' ');
  if (words.length <= max) return words;
  return words.slice(0, max - 1) + 'Ã¢â‚¬Â¦';
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function formatEffort(minutes: number): string {
  if (minutes <= 0) return 'no effort';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 8) return `${Math.round(hours * 10) / 10} hours`;
  const days = hours / 8;
  return days < 10 ? `${Math.round(days * 10) / 10} days` : `${Math.round(days / 5)} weeks`;
}
