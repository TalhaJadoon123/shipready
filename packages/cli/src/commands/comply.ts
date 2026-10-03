import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDashboard,
  findGaps,
  formatComplianceReport,
  generate,
  scanForCompliance,
  type ComplianceAnswer,
  type ComplianceScanFinding,
} from '@shipready/compliance';
import { bundleFiles, writeBundle, type BundleFormat } from '../lib/bundle.js';
import { c, error, info, warn } from '../ui.js';

/**
 * `shipready comply` -- the compliance documentation generator.
 *
 * Two commands in one: `init` generates a pack from questionnaire answers,
 * `scan` looks at the codebase for patterns the answers do not cover. Both
 * report gaps rather than pretending completeness, because a regulatory
 * document with plausible-looking blanks in it is worse than one with an
 * obvious hole in it.
 */

export interface ComplyOptions {
  answer: ComplianceAnswer;
  output: string;
  format: BundleFormat;
  json: boolean;
  interactive: boolean;
}

export interface ComplyOutcome {
  exitCode: number;
  documents: { id: string; title: string; path: string; gapCount: number }[];
  gaps: ReturnType<typeof findGaps>;
  score: number;
  outputDir: string;
  frameworks: string[];
}

export async function runComply(options: ComplyOptions): Promise<ComplyOutcome> {
  const outputDir = resolve(options.output);
  const result = generate(options.answer);
  const files = bundleFiles(result, options.answer, options.format);

  await writeBundle(files, options.format, outputDir);

  const documents = result.documents.map((document) => ({
    id: document.id,
    title: document.title,
    path: files.find((f) => f.path.includes(document.id.split('/')[1] ?? ''))?.path ?? '',
    gapCount: document.gaps.length,
  }));

  const gaps = result.gaps.length > 0 ? result.gaps : findGaps(options.answer);
  const dashboard = buildDashboard(result);

  if (options.json) {
    info(
      JSON.stringify(
        {
          frameworks: result.frameworks,
          documents,
          gaps,
          score: result.score,
          outputDir,
        },
        null,
        2,
      ),
    );
  } else {
    info(formatComplianceReport(dashboard));
    info('');
    info(`${c.green('+')} ${documents.length} document(s) written to ${outputDir}`);
    for (const document of documents) {
      const marker = document.gapCount > 0 ? c.yellow(`  ${document.gapCount} gap(s)`) : '';
      info(`    ${document.path}${marker}`);
    }
    if (gaps.some((g) => g.severity === 'blocker')) {
      info('');
      info(c.red(`${gaps.filter((g) => g.severity === 'blocker').length} blocker(s) remain.`));
      info('Read MANIFEST.md first: it lists what is missing and why each item matters.');
    }
    info('');
    info(c.dim('  This pack is a starting point, not legal advice, and not a conformity assessment.'));
  }

  return {
    exitCode: 0,
    documents,
    gaps,
    score: result.score,
    outputDir,
    frameworks: result.frameworks,
  };
}

export interface ComplianceScanOptions {
  path: string;
  json: boolean;
  answer?: ComplianceAnswer;
}

export interface ComplianceScanOutcome {
  exitCode: number;
  findings: ComplianceScanFinding[];
  undeclaredData: string[];
  filesScanned: number;
}

export async function runComplianceScan(options: ComplianceScanOptions): Promise<ComplianceScanOutcome> {
  const path = resolve(options.path);
  if (!existsSync(path)) {
    error(`No such path: ${options.path}`);
    return { exitCode: 2, findings: [], undeclaredData: [], filesScanned: 0 };
  }

  const result = await scanForCompliance(
    path,
    options.answer ? { aiSystem: { dataCategories: options.answer.aiSystem.dataCategories } } : undefined,
  );

  if (options.json) {
    info(JSON.stringify(result, null, 2));
  } else {
    info(`Scanned ${result.filesScanned} file(s) in ${result.durationMs} ms`);
    info('');
    if (result.findings.length === 0) {
      info(c.green('No compliance-relevant patterns found.'));
    } else {
      for (const finding of result.findings) {
        const colour =
          finding.severity === 'critical' ? c.red : finding.severity === 'high' ? c.yellow : c.dim;
        info(`${colour(finding.severity.toUpperCase())} ${finding.title} ${c.dim(`(${finding.framework} ${finding.article})`)}`);
        info(`  ${finding.description}`);
        info(`  ${c.dim('Fix:')} ${finding.remediation}`);
        for (const location of finding.locations.slice(0, 3)) {
          info(`  ${c.dim(`${location.path}:${location.line}`)}  ${location.snippet}`);
        }
        info('');
      }
    }
    if (result.undeclaredData.length > 0) {
      warn('Personal data found in code but not declared in the questionnaire:');
      for (const field of result.undeclaredData) info(`  - ${field}`);
      info('');
      info(c.dim('  Add these to the `ai.dataCategories` answer and regenerate.'));
    }
  }

  const hasCritical = result.findings.some((f) => f.severity === 'critical');
  return {
    exitCode: hasCritical ? 1 : 0,
    findings: result.findings,
    undeclaredData: result.undeclaredData,
    filesScanned: result.filesScanned,
  };
}