/**
 * Charts, hand-rolled as SVG.
 *
 * A charting library would be several hundred kilobytes to draw two shapes. The
 * charts here are a line and a polygon; the alternative is a dependency tree
 * to explain in a review for two elements of markup.
 */

export interface RadarDatum {
  label: string;
  score: number;
}

/**
 * Readiness by category.
 *
 * A radar rather than a bar chart because the question is "is this balanced?".
 * A codebase can score 90 with one category at 20, and that is exactly the
 * case a bar chart hides.
 */
export function RadarChart({ categories }: { categories: RadarDatum[] }): React.JSX.Element {
  if (categories.length < 3) {
    return <div className="empty">Not enough categories for a radar view.</div>;
  }

  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 44;
  const n = categories.length;

  const point = (i: number, fraction: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * r * fraction, cy + Math.sin(angle) * r * fraction];
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const points = categories.map((_, i) => point(i, f).join(',')).join(' ');
      return <polygon key={f} points={points} fill="none" stroke="var(--border)" strokeWidth={1} />;
    });

  const axes = categories.map((_, i) => {
    const [x, y] = point(i, 1);
    return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth={1} />;
  });

  const values = categories.map((c, i) => point(i, Math.max(0.02, c.score / 100)).join(',')).join(' ');

  const labels = categories.map((c, i) => {
    const [x, y] = point(i, 1.2);
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
    return (
      <text
        key={c.label}
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="middle"
        fontSize={9}
        fill="var(--muted)"
      >
        {c.label.split(' ')[0]}
      </text>
    );
  });

  const dots = categories.map((c, i) => {
    const [x, y] = point(i, Math.max(0.02, c.score / 100));
    return <circle key={c.label} cx={x} cy={y} r={3} fill={colourFor(c.score)} />;
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: 320, display: 'block', margin: '0 auto' }}>
      <title>Production readiness by category</title>
      {rings}
      {axes}
      <polygon points={values} fill="var(--accent)" fillOpacity={0.18} stroke="var(--accent)" strokeWidth={2} />
      {dots}
      {labels}
    </svg>
  );
}

/** The score over time. */
export function TrendsChart({ points }: { points: { at: string; score: number }[] }): React.JSX.Element {
  if (points.length < 2) {
    return <div className="empty">Two or more scans are needed to show a trend.</div>;
  }

  const width = 640;
  const height = 90;
  const pad = 4;
  const min = Math.min(...points.map((p) => p.score));
  const max = Math.max(...points.map((p) => p.score));
  const span = Math.max(1, max - min);

  const x = (i: number): number => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (score: number): number =>
    height - pad - ((score - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${line} ${x(points.length - 1).toFixed(1)},${height - pad}`;

  const last = points.at(-1)!;
  const first = points[0]!;
  const delta = last.score - first.score;

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} className="spark" preserveAspectRatio="none">
        <title>
          Readiness {first.score} to {last.score}
        </title>
        <polygon points={area} fill="var(--accent)" fillOpacity={0.12} />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
        <circle cx={x(points.length - 1)} cy={y(last.score)} r={3} fill="var(--accent)" />
      </svg>
      <div className="sub">
        {points.length} scans · {first.score} → {last.score}{' '}
        <span style={{ color: delta >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
          ({delta >= 0 ? '+' : ''}
          {delta})
        </span>
      </div>
    </>
  );
}

function colourFor(score: number): string {
  if (score >= 85) return 'var(--ok)';
  if (score >= 65) return 'var(--warn)';
  return 'var(--bad)';
}