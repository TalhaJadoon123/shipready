import { humanDuration } from '../scoring.js';
import type { ProductionReadinessReport } from '../types.js';

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

const VERDICT_EMOJI: Record<string, string> = {
  'PRODUCTION READY': '✅',
  'READY WITH CAVEATS': '🟡',
  'NEEDS WORK': '🟠',
  'NOT READY': '🔴',
};

const IMPACT_EMOJI: Record<string, string> = {
  blocker: '🛑',
  degradation: '⚠️',
  cosmetic: '🔧',
};

export interface MarkdownOptions {
  /** Include every finding, not just the top blockers. */
  full?: boolean;
  title?: string;
  /** Omit the compliance section when no mapping applies. */
  includeCompliance?: boolean;
}

/**
 * Markdown report.
 *
 * This is what gets posted to a pull request, so it has to survive being
 * rendered inside a GitHub comment as well as being written to a file. That
 * means: real headings, no HTML, no colour codes, and every finding given an
 * anchor so it can be linked.
 */
export function formatMarkdown(report: ProductionReadinessReport, options: MarkdownOptions = {}): string {
  const out: string[] = [];
  const title = options.title ?? 'Production Readiness Report';

  out.push(`## ${title}`);
  out.push('');
  out.push(`> ${VERDICT_EMOJI[report.verdict] ?? ''} **${report.verdict}** — score **${report.score}/100** (${report.grade})`);
  out.push('');

  // --- Score table ---
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| **Score** | ${report.score}/100 (${report.grade}) |`);
  out.push(`| **Verdict** | ${report.verdict} |`);
  out.push(`| **Project** | ${report.project.type} · ${report.project.totalLines.toLocaleString()} lines |`);
  out.push(`| **Findings** | ${report.summary.totalFindings} (${report.summary.blockers} blocker${report.summary.blockers === 1 ? '' : 's'}) |`);
  out.push(`| **Auto-fixable** | ${report.summary.fixable} |`);
  out.push(`| **Time to launch** | ${report.summary.estimatedTimeToLaunch} |`);
  out.push('');

  // --- Comparison ---
  if (report.comparison) {
    const cmp = report.comparison;
    const delta = cmp.scoreDelta;
    const trend = delta > 0 ? `📈 +${delta}` : delta < 0 ? `📉 ${delta}` : '➡️ no change';
    out.push(`**Since last scan:** ${cmp.previousScore} → ${report.score} (${trend}) · ${cmp.resolvedFindings} fixed, ${cmp.newFindings} new.`);
    out.push('');
  }

  // --- Top blockers ---
  if (report.topBlockers.length > 0) {
    out.push('### 🛑 Fix before launch');
    out.push('');
    report.topBlockers.forEach((b, i) => {
      out.push(`${i + 1}. **${b.title}** · ${SEVERITY_EMOJI[b.severity] ?? ''} \`${b.severity}\` · ~${humanDuration(b.effortMinutes)}`);
      out.push(`   \`${b.path}:${b.line}\` — ${b.rationale}`);
      out.push(`   **Fix:** ${b.remediation}`);
      if (b.autoFix) out.push(`   **Auto-fix:** \`shipready fix .\` generates this. ${b.autoFix.description}`);
      out.push('');
    });
  } else {
    out.push('### ✅ No launch blockers');
    out.push('');
    out.push('The remaining findings are quality improvements, not things standing between you and real users.');
    out.push('');
  }

  // --- Category table ---
  out.push('### Category scores');
  out.push('');
  out.push('| Category | Score | Weight | Blockers | Findings |');
  out.push('|---|---:|---:|---:|---:|');
  for (const cat of [...report.categories].sort((a, b) => a.score - b.score)) {
    out.push(`| ${cat.label} | ${bar(cat.score)} **${cat.score}** | ${cat.weight} | ${cat.blockers || '—'} | ${cat.findingCount} |`);
  }
  out.push('');

  // --- Compliance ---
  if (options.includeCompliance !== false) {
    const frameworks = new Map<string, { count: number; articles: Set<string> }>();
    for (const f of report.findings) {
      for (const m of f.compliance) {
        const e = frameworks.get(m.framework) ?? { count: 0, articles: new Set<string>() };
        e.count++;
        if (m.article) e.articles.add(m.article);
        frameworks.set(m.framework, e);
      }
    }
    if (frameworks.size > 0) {
      out.push('### Compliance exposure');
      out.push('');
      out.push('| Framework | Gaps | Most cited provisions |');
      out.push('|---|---:|---|');
      for (const [fw, e] of [...frameworks.entries()].sort((a, b) => b[1].count - a[1].count)) {
        out.push(`| ${fw} | ${e.count} | ${shortenArticles([...e.articles])} |`);
      }
      out.push('');
      out.push(
        'Run `shipready comply init` to generate the documentation these findings map onto.',
      );
      out.push('');
    }
  }

  // --- Findings ---
  const findings = options.full ? report.findings : report.findings.filter((f) => f.productionImpact !== 'cosmetic');
  // Anchor every finding, including omitted ones, so a link from elsewhere in
  // the document (a PR comment, a CI annotation) always resolves.
  const anchors = report.findings.map((f) => `<a id="${f.id}"></a>`).join('\n');
  if (findings.length > 0) {
    out.push(`### Findings (${findings.length}${options.full ? '' : ', cosmetic omitted'})`);
    out.push('');
    out.push('| | Severity | Finding | Location | Impact | Fix |');
    out.push('|---|---|---|---|---|---|');
    for (const f of findings) {
      out.push(
        `| ${SEVERITY_EMOJI[f.severity] ?? ''} | ${f.severity} | <a id="${f.id}"></a>**${f.title}**<br/>${escapePipes(f.evidence.summary)} | \`${f.location.path}:${f.location.startLine}\` | ${IMPACT_EMOJI[f.productionImpact] ?? ''} ${f.productionImpact} | ~${humanDuration(f.effortMinutes)} |`,
      );
    }
    out.push('');
    out.push('<details><summary>Remediation detail</summary>');
    out.push('');
    for (const f of findings.filter((x) => x.severity === 'critical' || x.severity === 'high').slice(0, 30)) {
      out.push(`#### ${f.title}`);
      out.push('');
      out.push(`- **Rule:** \`${f.ruleId}\` · **Confidence:** ${(f.confidence * 100).toFixed(0)}% · **Effort:** ~${humanDuration(f.effortMinutes)}`);
      if (f.compliance.length > 0) {
        out.push(`- **Compliance:** ${f.compliance.map((m) => `${m.framework}${m.article ? ` ${m.article}` : ''}`).join(', ')}`);
      }
      out.push(`- **Why it matters:** ${f.description}`);
      out.push(`- **Fix:** ${f.remediation}`);
      out.push('');
    }
    out.push('</details>');
    out.push('');
  }

  // Anchors for anything the table above omitted.
  const rendered = new Set(findings.map((f) => f.id));
  const orphans = report.findings.filter((f) => !rendered.has(f.id));
  if (orphans.length > 0) {
    out.push(anchors);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    `<sub>Generated by ShipReady · ${new Date(report.generatedAt).toISOString()} · ${report.durationMs} ms · \`shipready scan . --verbose\`</sub>`,
  );
  out.push('');
  return out.join('\n');
}

/**
 * Shorten article references for the compliance table.
 *
 * `Article 9` becomes `Art. 9`; an OWASP or NIST reference like `A07:2021` is
 * already short and is left alone. Five is the most a table cell should hold.
 */
function shortenArticles(articles: readonly string[]): string {
  if (articles.length === 0) return '—';
  return articles
    .slice(0, 5)
    .map((a) => (a.startsWith('Article ') ? `Art. ${a.slice('Article '.length)}` : a))
    .join(', ');
}

function bar(score: number, size = 10): string {
  const filled = Math.round((score / 100) * size);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, size - filled));
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * SARIF 2.1.0 for GitHub Code Scanning.
 *
 * Rules are deduplicated across findings so a rule that fired 40 times is one
 * `reportingDescriptor` with 40 results -- which is what makes the alert list
 * in the GitHub UI readable.
 */
export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: { name: string; version: string; informationUri: string; rules: SarifRule[] } };
  results: SarifResult[];
  automationDetails?: { id: string };
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help?: { text: string; markdown: string };
  defaultConfiguration: { level: string };
  properties: {
    tags: string[];
    precision: string;
    'security-severity'?: string;
    'problem.severity'?: string;
  };
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; startColumn?: number; snippet?: { text: string } };
    };
  }[];
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

const SARIF_LEVEL: Record<string, string> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

const SARIF_SECURITY_SEVERITY: Record<string, string> = {
  critical: '9.0',
  high: '7.0',
  medium: '5.0',
  low: '3.0',
  info: '1.0',
};

const TOOL_VERSION = '0.1.0';

/**
 * SARIF 2.1.0 for GitHub Code Scanning, as a JSON string.
 *
 * Returned as a string rather than an object so the formatter is symmetric with
 * every other one: formatters render, the CLI writes. `parseSarif` is available
 * for callers that want the structure.
 */
export function formatSarif(report: ProductionReadinessReport, options: { toolName?: string } = {}): string {
  return JSON.stringify(buildSarif(report, options), null, 2);
}

export function parseSarif(json: string): SarifLog {
  return JSON.parse(json) as SarifLog;
}

function buildSarif(report: ProductionReadinessReport, options: { toolName?: string } = {}): SarifLog {
  const ruleMap = new Map<string, SarifRule>();
  const results: SarifResult[] = [];

  for (const f of report.findings) {
    if (!ruleMap.has(f.ruleId)) {
      ruleMap.set(f.ruleId, {
        id: f.ruleId,
        name: f.title,
        shortDescription: { text: f.title },
        fullDescription: { text: f.description },
        help: {
          text: f.remediation,
          markdown: `**${f.title}**\n\n${f.description}\n\n**Fix:** ${f.remediation}`,
        },
        defaultConfiguration: { level: SARIF_LEVEL[f.severity] ?? 'warning' },
        properties: {
          tags: [f.category, f.productionImpact, ...f.tags],
          precision: f.confidence >= 0.9 ? 'high' : f.confidence >= 0.6 ? 'medium' : 'low',
          ...(f.severity === 'critical' || f.severity === 'high'
            ? {
                'security-severity': SARIF_SECURITY_SEVERITY[f.severity] ?? '7.0',
                'problem.severity': f.severity,
              }
            : {}),
        },
      });
    }

    const region: SarifResult['locations'][0]['physicalLocation']['region'] = {
      startLine: Math.max(1, f.location.startLine),
      ...(f.location.startColumn ? { startColumn: f.location.startColumn } : {}),
      ...(f.location.snippet ? { snippet: { text: f.location.snippet } } : {}),
    };

    results.push({
      ruleId: f.ruleId,
      level: SARIF_LEVEL[f.severity] ?? 'warning',
      message: { text: `${f.title}: ${f.evidence.summary}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.location.path },
            region,
          },
        },
      ],
      partialFingerprints: {
        shipreadyFindingId: f.id,
        shipreadyEvidenceHash: f.evidence.summary,
      },
      properties: {
        severity: f.severity,
        confidence: f.confidence,
        productionImpact: f.productionImpact,
        category: f.category,
        effortMinutes: f.effortMinutes,
        fixable: f.fixable,
        compliance: f.compliance.map((c) => `${c.framework}${c.article ? ` ${c.article}` : ''}`),
      },
    });
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: options.toolName ?? 'ShipReady',
            version: TOOL_VERSION,
            informationUri: 'https://shipready.ai',
            rules: [...ruleMap.values()],
          },
        },
        results,
        automationDetails: { id: 'shipready/production-readiness' },
      },
    ],
  };
}

/**
 * The pull-request comment.
 *
 * Short enough to read without expanding, and it answers the only question a
 * reviewer actually has: may I merge this?
 */
export function formatGithubComment(report: ProductionReadinessReport, options: { maxBlockers?: number } = {}): string {
  const max = options.maxBlockers ?? 3;
  const s = report.summary;
  const out: string[] = [];

  const icon =
    report.verdict === 'PRODUCTION READY'
      ? '✅'
      : report.verdict === 'READY WITH CAVEATS'
        ? '🟡'
        : report.verdict === 'NEEDS WORK'
          ? '🟠'
          : '🔴';

  out.push(`## ${icon} ShipReady: ${report.verdict}`);
  out.push('');

  if (report.comparison) {
    const d = report.comparison.scoreDelta;
    const trend = d > 0 ? `📈 +${d}` : d < 0 ? `📉 ${d}` : '➡️';
    out.push(`**${trend}** vs. last scan (${report.comparison.previousScore} → ${report.score}) · ${report.comparison.resolvedFindings} fixed, ${report.comparison.newFindings} new`);
  } else {
    out.push(`**Score ${report.score}/100** (${report.grade})`);
  }
  out.push('');

  // Category bar, one line each — compact enough for a comment.
  const worst = [...report.categories].sort((a, b) => a.score - b.score).slice(0, 6);
  out.push('| | | | |');
  out.push('|---|---:|---:|---|');
  for (const cat of worst) {
    const status = cat.blockers > 0 ? `🛑 ${cat.blockers}` : cat.score >= 85 ? '✅' : '⚠️';
    out.push(`| ${cat.label} | ${bar(cat.score, 8)} ${cat.score} | ${status} | ${cat.findingCount} |`);
  }
  out.push('');

  if (report.topBlockers.length > 0) {
    const shown = report.topBlockers.slice(0, max);
    out.push(`### Top ${shown.length} blocker${shown.length === 1 ? '' : 's'}`);
    out.push('');
    shown.forEach((b, i) => {
      out.push(`${i + 1}. **${b.title}** — \`${b.path}:${b.line}\` (~${humanDuration(b.effortMinutes)})`);
      out.push(`   ${b.remediation}`);
    });
    if (report.topBlockers.length > shown.length) {
      out.push('');
      out.push(`_...and ${report.topBlockers.length - shown.length} more. Run \`shipready scan\` for the full list._`);
    }
    out.push('');
  }

  const fixable = report.findings.filter((f) => f.fixable).length;
  out.push(
    `<sub>${s.totalFindings} findings · ${s.bySeverity.critical} critical · ${s.bySeverity.high} high · ${fixable} auto-fixable · ${report.summary.estimatedTimeToLaunch} to launch readiness</sub>`,
  );
  out.push('');
  out.push('<details><summary>Full report</summary>');
  out.push('');
  out.push(formatMarkdown(report, { full: false, title: '' }));
  out.push('');
  out.push('</details>');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}