import { humanDuration } from '../scoring.js';
import { CATEGORY_LABELS, SEVERITY_ORDER, type ProductionReadinessReport, type Severity } from '../types.js';

/**
 * ANSI helpers.
 *
 * Colour is off when NO_COLOR is set, when stdout is not a TTY, or when
 * `setColour(false)` is called. This matters for CI more than for humans:
 * escape codes in a redirected report make every diff unreadable.
 */
let colourEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

export function setColour(enabled: boolean): void {
  colourEnabled = enabled && process.env.NO_COLOR === undefined;
}

export function isColour(): boolean {
  return colourEnabled;
}

/** Apply an SGR parameter list to a string, when colour is enabled. */
function wrap(code: string, s: string): string {
  return colourEnabled ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const c = {
  bold: (s: string): string => wrap('1', s),
  dim: (s: string): string => wrap('2', s),
  red: (s: string): string => wrap('31', s),
  green: (s: string): string => wrap('32', s),
  yellow: (s: string): string => wrap('33', s),
  blue: (s: string): string => wrap('34', s),
  magenta: (s: string): string => wrap('35', s),
  cyan: (s: string): string => wrap('36', s),
  grey: (s: string): string => wrap('90', s),
  bgRed: (s: string): string => wrap('41;97', s),
  bgGreen: (s: string): string => wrap('42;30', s),
  bgYellow: (s: string): string => wrap('43;30', s),
  bgBlue: (s: string): string => wrap('44;97', s),
};

const SEVERITY_STYLE: Record<Severity, { label: string; code: string; colour: (s: string) => string }> = {
  critical: { label: 'CRITICAL', code: '41;97', colour: c.bgRed },
  high: { label: 'HIGH    ', code: '31', colour: c.red },
  medium: { label: 'MEDIUM  ', code: '33', colour: c.yellow },
  low: { label: 'LOW     ', code: '34', colour: c.blue },
  info: { label: 'INFO    ', code: '90', colour: c.grey },
};

export function severityBadge(severity: Severity): string {
  const style = SEVERITY_STYLE[severity];
  return style.colour(style.label);
}

const GRADE_CODES: Record<string, string> = {
  A: '42;30',
  'A-': '42;30',
  'B+': '32',
  B: '32',
  'B-': '32',
  'C+': '33',
  C: '33',
  'C-': '33',
  'D+': '43;30',
  D: '43;30',
  'D-': '43;30',
  E: '43;30',
  F: '31',
  'F-': '31',
};

export function gradeBadge(grade: string): string {
  return wrap(GRADE_CODES[grade] ?? '1', grade);
}

const VERDICT_CODES: Record<string, string> = {
  'PRODUCTION READY': '42;30',
  'READY WITH CAVEATS': '43;30',
  'NEEDS WORK': '33',
  'NOT READY': '41;97',
};

export function verdictBadge(verdict: string): string {
  return wrap(VERDICT_CODES[verdict] ?? '1', verdict);
}

function termWidth(): number {
  return process.stdout.columns ?? 100;
}

/** `readonly██████░░░░░░░░░░░░░░░░` with colour applied when enabled. */
export function scoreBar(score: number, size = 24): string {
  const filled = Math.max(0, Math.min(size, Math.round((score / 100) * size)));
  if (!colourEnabled) return `[${'█'.repeat(filled)}${'░'.repeat(size - filled)}]`;
  const colour = score >= 85 ? c.green : score >= 65 ? c.yellow : score >= 45 ? c.bgYellow : c.red;
  return `[${colour('█'.repeat(filled))}${c.dim('░'.repeat(size - filled))}]`;
}

/**
 * The console report.
 *
 * Ordered by what a person needs in order to decide, not by how the data is
 * structured: verdict, score, the five things standing between you and launch,
 * then the category breakdown, then everything else.
 */
export function formatConsole(
  report: ProductionReadinessReport,
  options: { verbose?: boolean; maxFindings?: number } = {},
): string {
  const out: string[] = [];
  const name = report.project.type === 'unknown' ? 'this project' : `${report.project.type} project`;
  const rule = '─'.repeat(Math.min(termWidth() - 4, 76));

  out.push('');
  out.push(`${c.bold(c.cyan('  ShipReady'))} ${c.dim('production readiness report')}`);
  out.push('');
  out.push(
    `  ${verdictBadge(report.verdict)}   ${scoreBar(report.score)}  ${c.bold(String(report.score))}/100  ${gradeBadge(report.grade)}`,
  );
  out.push('');
  out.push(
    `  ${c.dim('Scanned')}   ${name} · ${report.project.totalLines.toLocaleString()} lines · ${report.project.frameworks.slice(0, 6).join(', ') || 'no framework detected'}`,
  );

  const severityParts = SEVERITY_ORDER.map((severity) => {
    const count = report.summary.bySeverity[severity];
    if (count === 0) return null;
    const style = SEVERITY_STYLE[severity];
    return `${wrap(style.code, String(count).padStart(2))} ${severity}`;
  }).filter((part): part is string => part !== null);
  out.push(`  ${c.dim('Findings')}  ${report.summary.totalFindings} total${severityParts.length ? ` · ${severityParts.join(c.dim(' · '))}` : ''}`);
  out.push(
    `  ${c.dim('Impact')}    ${report.summary.blockers} blocker(s) · ${report.summary.byImpact.degradation} degradation · ${report.summary.byImpact.cosmetic} cosmetic`,
  );
  out.push('');

  // --- Top blockers ---
  if (report.topBlockers.length > 0) {
    out.push(c.bold(`  Fix before launch (${report.topBlockers.length})`));
    out.push(c.dim(`  ${rule}`));
    report.topBlockers.forEach((blocker, i) => {
      out.push('');
      out.push(`  ${c.bold(`${i + 1}.`)} ${c.bold(blocker.title)}  ${severityBadge(blocker.severity)} ${c.dim(`~${humanDuration(blocker.effortMinutes)}`)}`);
      out.push(`     ${c.dim(`${blocker.path}:${blocker.line}`)}`);
      out.push(`     ${blocker.rationale}`);
      out.push(`     ${c.green('->')} ${wrapText(blocker.remediation, termWidth() - 8)}`);
      if (blocker.autoFix) {
        out.push(`     ${c.yellow('*')} ${c.dim(`shipready fix --apply   (${blocker.autoFix.description})`)}`);
      }
    });
    out.push('');
  } else {
    out.push(c.green('  No launch blockers. The remaining findings are quality improvements.'));
    out.push('');
  }

  // --- Category breakdown ---
  out.push(c.bold('  Category scores'));
  out.push(c.dim(`  ${rule}`));
  out.push('');
  const maxWeight = Math.max(...report.categories.map((x) => x.weight), 1);
  for (const category of [...report.categories].sort((a, b) => a.score - b.score)) {
    const barWidth = Math.max(8, Math.min(26, Math.round((category.weight / maxWeight) * 12) + 8));
    const flag = category.blockers > 0 ? c.red(`${category.blockers} blocker`) : c.dim('-');
    out.push(
      `  ${pad(category.label, 18)} ${scoreBar(category.score, barWidth)} ${pad(String(category.score), 4)} ${pad(c.dim(`w:${category.weight}`), 6)} ${pad(flag, 16)} ${c.dim(`${category.findingCount} finding(s)`)}`,
    );
  }
  out.push('');

  // --- Comparison ---
  if (report.comparison) {
    const cmp = report.comparison;
    const arrow =
      cmp.scoreDelta > 0 ? c.green(`up +${cmp.scoreDelta}`) : cmp.scoreDelta < 0 ? c.red(`down ${cmp.scoreDelta}`) : c.dim('no change');
    out.push(c.bold('  Since last scan'));
    out.push(c.dim(`    score ${cmp.previousScore} -> ${report.score}  ${arrow}`));
    out.push(
      c.dim(`    ${cmp.resolvedFindings} fixed, ${cmp.newFindings} new, blockers ${cmp.blockersDelta > 0 ? `+${cmp.blockersDelta}` : cmp.blockersDelta}`),
    );
    for (const delta of cmp.categoryDeltas
      .filter((x) => x.delta !== 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 4)) {
      const deltaArrow = delta.delta > 0 ? c.green(`+${delta.delta}`) : c.red(String(delta.delta));
      out.push(c.dim(`    ${pad(delta.label, 18)} ${delta.from} -> ${delta.to}  ${deltaArrow}`));
    }
    out.push('');
  }

  // --- Compliance ---
  // The loop variable must not be `c`: that is the colour helper, and
  // shadowing it silently disables every colour in this block.
  const complianceCoverage = buildComplianceCoverage(report);
  if (complianceCoverage.length > 0) {
    out.push(c.bold('  Compliance exposure'));
    out.push(c.dim(`  ${rule}`));
    for (const frame of complianceCoverage) {
      const provisions = frame.top.map((t) => t.replace(/^Article /, 'Art. ')).join(', ');
      out.push(`  ${pad(frame.framework, 14)} ${pad(`${frame.findingCount} gap(s)`, 14)} ${c.dim(provisions)}`);
    }
    out.push('');
  }

  // --- Findings ---
  const maxFindings = options.verbose ? report.findings.length : (options.maxFindings ?? 25);
  const shown = report.findings.slice(0, maxFindings);
  if (shown.length > 0) {
    out.push(c.bold(`  All findings (${report.findings.length})`));
    out.push(c.dim(`  ${rule}`));
    for (const finding of shown) {
      out.push('');
      out.push(`  ${severityBadge(finding.severity)} ${pad(finding.title, 58)} ${c.dim(`~${humanDuration(finding.effortMinutes)}`)}`);
      out.push(`      ${c.cyan(finding.location.path)}:${c.dim(String(finding.location.startLine))}`);
      out.push(`      ${c.dim(finding.evidence.summary)}`);
    }
    if (report.findings.length > shown.length) {
      out.push('');
      out.push(c.dim(`  ... ${report.findings.length - shown.length} more. Use --verbose for everything, or --format json.`));
    }
    out.push('');
  }

  // --- Fixes available ---
  if (report.summary.fixable > 0) {
    out.push(c.dim(`  ${report.summary.fixable} finding(s) can be auto-fixed. Run: shipready fix .`));
    out.push('');
  }

  out.push(c.dim(`  Scanned ${report.project.totalLines.toLocaleString()} lines in ${report.durationMs} ms · ${report.generatedAt}`));
  out.push('');
  return out.join('\n');
}

function buildComplianceCoverage(
  report: ProductionReadinessReport,
): { framework: string; findingCount: number; top: string[] }[] {
  const byFramework = new Map<string, { findingCount: number; articles: Set<string> }>();
  for (const finding of report.findings) {
    for (const mapping of finding.compliance) {
      const entry = byFramework.get(mapping.framework) ?? { findingCount: 0, articles: new Set<string>() };
      entry.findingCount++;
      if (mapping.article) entry.articles.add(mapping.article);
      byFramework.set(mapping.framework, entry);
    }
  }
  return [...byFramework.entries()]
    .map(([framework, entry]) => ({ framework, findingCount: entry.findingCount, top: [...entry.articles].slice(0, 4) }))
    .sort((a, b) => b.findingCount - a.findingCount)
    .slice(0, 6);
}

export function formatJson(report: ProductionReadinessReport): string {
  return JSON.stringify(report, null, 2);
}

/** Single-line summary for shell prompts and CI annotations. */
export function formatGithubSummary(report: ProductionReadinessReport): string {
  const s = report.summary;
  const blockers = s.bySeverity.critical + s.bySeverity.high;
  return [
    `Score ${report.score}/100 (${report.grade})`,
    report.verdict,
    `${blockers} high-severity finding(s)`,
    `${s.blockers} launch blocker(s)`,
    `${s.fixable} auto-fixable`,
  ].join(' | ');
}

/** Pad to `n` visible columns, ignoring ANSI escapes. */
export function pad(s: string, n: number): string {
  const stripped = stripAnsi(s);
  return stripped + ' '.repeat(Math.max(0, n - stripped.length));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function wrapText(text: string, cols: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > cols && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n     ');
}

export { CATEGORY_LABELS, humanDuration };