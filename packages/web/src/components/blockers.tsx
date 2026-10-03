export interface Blocker {
  title: string;
  path: string;
  line: number;
  remediation: string;
  effortMinutes: number;
  productionImpact: string;
}

/**
 * The blocker list.
 *
 * Ordered worst first, with the remediation in full. A readiness tool that
 * says "5 blockers" and then makes you go find them has moved the work rather
 * than removed it; the whole point is that this list is actionable on its own.
 */
export function BlockerList({ blockers }: { blockers: Blocker[] }) {
  const rank = { blocker: 0, degradation: 1, cosmetic: 2 } as Record<string, number>;
  const sorted = [...blockers].sort(
    (a, b) => (rank[a.productionImpact] ?? 3) - (rank[b.productionImpact] ?? 3),
  );

  return (
    <>
      {sorted.map((blocker, index) => (
        <div className="blocker" key={`${blocker.path}:${blocker.line}:${index}`}>
          <h3>
            {index + 1}. {blocker.title}{' '}
            <span className="pill bad">{blocker.productionImpact}</span>
          </h3>
          <div className="mono" style={{ color: 'var(--accent)' }}>
            {blocker.path}:{blocker.line}
          </div>
          <div style={{ marginTop: 6 }}>{blocker.remediation}</div>
          <div className="sub" style={{ marginTop: 4 }}>
            ≈ {formatEffort(blocker.effortMinutes)}
          </div>
        </div>
      ))}
    </>
  );
}

/** Minutes into something an engineer recognises. */
export function formatEffort(minutes: number): string {
  if (minutes <= 0) return 'no effort';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 8) return `${Math.round(hours * 10) / 10} hours`;
  const days = hours / 8;
  return days < 10 ? `${Math.round(days * 10) / 10} days` : `${Math.round(days / 5)} weeks`;
}