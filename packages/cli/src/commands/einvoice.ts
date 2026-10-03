import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  fixInvoice,
  parseXml,
  validateInvoice,
  convertInvoice,
  type InvoiceDocument,
  type ValidationResult,
} from '@shipready/einvoice';
import { emit } from '../ui.js';

/**
 * `shipready validate` and `shipready convert`.
 *
 * Every exit code here is something CI branches on, so the command layer is
 * tested rather than just the library underneath it.
 */

export interface ValidateOptions {
  path: string;
  fix: boolean;
  json: boolean;
  cwd: string;
  output?: string;
}

export interface ValidateOutcome extends ValidationResult {
  exitCode: number;
  /**
   * Set when `--fix` was used.
   *
   * `remaining` is errors that survive the correction. It is separate from
   * `changes` because "fixed 4 fields, 2 problems remain" and "fixed 4 fields,
   * everything is fine now" are different answers to the question a user is
   * actually asking.
   */
  fixed?: {
    changes: number;
    remainingErrors: number;
    document: InvoiceDocument;
    applied: { path: string; from: string; to: string; ruleId: string }[];
  };
  /** Rendered output, present when `json` is set. */
  output?: string;
}

/**
 * Validate an e-invoice.
 *
 * Exit codes: 0 valid, 1 invalid, 2 the file could not be read or parsed.
 * Distinguishing 2 from 1 matters: an unreadable path is an operational
 * mistake, an invalid document is a business problem, and conflating them
 * makes a CI failure impossible to diagnose.
 */
export async function runValidate(options: ValidateOptions): Promise<ValidateOutcome> {
  if (!existsSync(options.path)) {
    return emptyOutcome(2, `No such file: ${options.path}`);
  }

  const xml = await readFile(options.path, 'utf8');

  const fixed = options.fix ? fixInvoice(xml) : null;
  const result = validateInvoice(fixed ? fixed.document : xml);

  let output: string | undefined;
  // With `--output`, the *document* is written, not the report: someone who asks
  // for a fixed file wants the fixed invoice.
  const fixedDocument = fixed ? await renderNfse(fixed.document) : undefined;
  if (fixed && fixedDocument) await emit(fixedDocument, options.output);

  if (options.json) {
    output = JSON.stringify(
      {
        ...result,
        ...(fixed
          ? {
              fixed: {
                changes: fixed.changes,
                remainingErrors: fixed.remaining,
                applied: fixed.applied,
                document: fixed.document,
              },
            }
          : {}),
        ...(fixedDocument ? { fixedXml: fixedDocument } : {}),
      },
      null,
      2,
    );
    if (!options.output) await emit(output);
  } else {
    const { formatResult } = await import('@shipready/einvoice');
    const lines = [formatResult(result), '', ...scopeDisclaimer()];
    if (fixed && fixed.changes > 0) {
      lines.splice(
        1,
        0,
        `Fixed ${fixed.changes} field(s):`,
        ...fixed.applied.map((a) => `  ${a.path}: ${a.from} -> ${a.to}`),
        '',
      );
    }
    if (!options.output) await emit(lines.join('\n'));
  }

  return {
    ...result,
    exitCode: result.valid ? 0 : 1,
    ...(fixed
      ? {
          fixed: {
            changes: fixed.changes,
            remainingErrors: fixed.remaining,
            document: fixed.document,
            applied: fixed.applied,
          },
        }
      : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

export interface ConvertOptions {
  path: string;
  to: 'xml' | 'csv' | 'json' | 'ubl';
  cwd: string;
  output?: string;
}

export interface ConvertOutcome {
  exitCode: number;
  output: string;
  warnings: string[];
  unmapped: { field: string; value: string; reason: string }[];
}

/** Convert between invoice formats. Never guesses at an unmappable field. */
export async function runConvert(options: ConvertOptions): Promise<ConvertOutcome> {
  if (options.to !== 'xml' && options.to !== 'csv' && options.to !== 'json' && options.to !== 'ubl') {
    return {
      exitCode: 2,
      output: '',
      warnings: [`Unknown target "${options.to}". Use xml, csv, json or ubl.`],
      unmapped: [],
    };
  }

  if (!existsSync(options.path)) {
    return { exitCode: 2, output: '', warnings: [`No such file: ${options.path}`], unmapped: [] };
  }

  const xml = await readFile(options.path, 'utf8');

  // UBL is not a target this tool emits; asking for it is a mistake worth
  // naming rather than silently substituting something else.
  if (options.to === 'ubl') {
    return {
      exitCode: 2,
      output: '',
      warnings: ['UBL is a source format, not a target. ShipReady reads UBL and writes xml, csv or json.'],
      unmapped: [],
    };
  }

  // Refuse an unparseable document rather than emitting an empty file. An empty
  // CSV that looks successful is worse than an error.
  const { root } = parseXml(xml);
  if (!root) {
    return {
      exitCode: 2,
      output: '',
      warnings: ['The document could not be parsed as XML, so there is nothing to convert.'],
      unmapped: [],
    };
  }

  const converted = convertInvoice(xml, options.to);
  if (converted.output.trim() === '') {
    return {
      exitCode: 2,
      output: '',
      warnings: ['The document parsed but produced no output; it is not a recognised invoice layout.'],
      unmapped: converted.unmapped,
    };
  }

  await emit(converted.output, options.output);

  return {
    exitCode: 0,
    output: converted.output,
    warnings: converted.warnings,
    unmapped: converted.unmapped,
  };
}

/**
 * Render a corrected document back to NFS-e XML.
 *
 * Round-tripping through the library's converter means the file the user gets
 * back is produced by exactly the same code path as `shipready convert`, so the
 * two can never disagree about the format.
 */
async function renderNfse(document: InvoiceDocument): Promise<string> {
  const { toNfseXml } = await import('@shipready/einvoice');
  return toNfseXml(document).output;
}

/**
 * Scope disclaimer.
 *
 * Repeated on every validation, because the most damaging failure mode for this
 * tool would be someone reading "VALID" and assuming the tax authority has
 * accepted it. We validate against published schemas and business rules; we do
 * not clear, and we cannot.
 */
function scopeDisclaimer(): string[] {
  return [
    'Scope: this validates against published schemas and business rules.',
    'It does not clear against a tax authority and does not certify acceptance.',
    'Clearing requires certification as a technical provider in each jurisdiction.',
  ];
}

function emptyOutcome(exitCode: number, message: string): ValidateOutcome {
  return {
    valid: false,
    score: 0,
    issues: [
      {
        ruleId: 'GENERAL/unreadable',
        severity: 'error',
        category: 'schema',
        path: '/',
        message,
        fixable: false,
      },
    ],
    counts: { error: 1, warning: 0, info: 0 },
    country: 'BR',
    documentNumber: '',
    documentType: '',
    issuer: '',
    total: 0,
    currency: '',
    validatedAt: new Date().toISOString(),
    computed: null,
    exitCode,
  };
}

export { detectCountry } from '@shipready/einvoice';