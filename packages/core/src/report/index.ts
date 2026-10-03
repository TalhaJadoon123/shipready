import type { ProductionReadinessReport } from '../types.js';
import { formatConsole, formatGithubSummary } from './console.js';
import {
  formatGithubComment,
  formatMarkdown,
  formatSarif,
  parseSarif,
  type MarkdownOptions,
  type SarifLog,
} from './markdown.js';
import { formatHtml } from './html.js';
import { formatJson } from './json.js';

export type ReportFormat = 'console' | 'json' | 'markdown' | 'md' | 'sarif' | 'html' | 'github' | 'summary';

export interface FormatOptions {
  verbose?: boolean;
  full?: boolean;
  maxFindings?: number;
  maxBlockers?: number;
  title?: string;
  toolName?: string;
  includeCompliance?: boolean;
}

export {
  formatConsole,
  formatJson,
  formatMarkdown,
  formatSarif,
  parseSarif,
  formatHtml,
  formatGithubComment,
  formatGithubSummary,
};
export { toScanSummary, type ScanSummaryJson } from './json.js';
export { setColour, isColour, scoreBar, gradeBadge, verdictBadge, severityBadge } from './console.js';
export type { MarkdownOptions, SarifLog };

/**
 * Format a report.
 *
 * Returns a string rather than writing, so the CLI owns all I/O. That keeps
 * the SARIF upload, the markdown comment and the console output going through
 * exactly the same pipeline.
 */
export function formatReport(
  report: ProductionReadinessReport,
  format: ReportFormat,
  options: FormatOptions = {},
): string {
  switch (format) {
    case 'console':
      return formatConsole(report, { verbose: options.verbose, maxFindings: options.maxFindings });
    case 'json':
      return formatJson(report);
    case 'markdown':
    case 'md':
      return formatMarkdown(report, { full: options.full, title: options.title, includeCompliance: options.includeCompliance });
    case 'sarif':
      return formatSarif(report, { toolName: options.toolName });
    case 'html':
      return formatHtml(report, { title: options.title });
    case 'github':
      return formatGithubComment(report, { maxBlockers: options.maxBlockers });
    case 'summary':
      return formatGithubSummary(report);
    default:
      throw new Error(`Unknown report format "${format}". Use console, json, markdown, sarif, html, github or summary.`);
  }
}