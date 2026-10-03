/**
 * `@shipready/einvoice` -- validation and conversion for e-invoicing.
 *
 * **Scope, deliberately narrow: we validate and we convert. We do not clear.**
 * Government clearance requires certification as a technical service provider
 * in each jurisdiction, and it carries liability that a validation tool has no
 * business taking on. A validator that tells you your document is well-formed
 * is genuinely useful; one that promises the tax authority will accept it is
 * not something we can honestly deliver.
 */
import { parseXml, find, findAll, text, num, attr } from './xml.js';
import { parseBrazilXml } from './countries/parse-brazil.js';
import {
  validateBrazilDocument,
  fixBrazilDocument,
  formatBrazilResult,
  type BrazilOptions,
} from './countries/validate-brazil.js';
import { fromUbl, toCsv, toNfseXml } from './convert.js';
import type {
  ConversionResult,
  CountryCode,
  FixResult,
  InvoiceDocument,
  ValidationIssue,
  ValidationResult,
} from './types.js';
import { round2 } from './types.js';

export type {
  ConversionDocument,
  CountryCode,
  FixResult,
  InvoiceDocument,
  ValidationIssue,
  ValidationResult,
  XmlNode,
} from './types.js';
export { round2, round4 } from './types.js';
export type { BrazilOptions } from './countries/validate-brazil.js';
export {
  validateCnpj,
  validateCpf,
  formatCnpj,
  formatCpf,
  ISS_TAXES,
  VALID_UOM,
} from './countries/brazil.js';
export { validateCep } from './xml.js';
export { toCsv, toNfseXml, fromUbl, escapeXml } from './convert.js';

export interface ValidateOptions extends BrazilOptions {
  /** Infer the country from the document. Defaults to true. */
  autoDetect?: boolean;
  /** Numbers already issued, for duplicate detection. */
  issuedNumbers?: Set<string>;
}

/**
 * Validate an invoice document against its country's rules.
 *
 * Accepts either an already-parsed document or the raw XML. Every path returns
 * a `ValidationResult`: a thrown exception here would mean a malformed invoice
 * crashed the tool, which is the one input we know we will receive.
 */
export function validateInvoice(
  input: InvoiceDocument | string,
  options: ValidateOptions = {},
): ValidationResult {
  if (typeof input !== 'string') {
    return validateDocument(input, options);
  }
  return validateXml(input, options);
}

/** Validate a raw fiscal XML. */
export function validateXml(xml: string, options: ValidateOptions = {}): ValidationResult {
  const { root, issues: xmlIssues } = parseXml(xml);
  if (!root) {
    return emptyResult(
      'EU',
      xmlIssues.length > 0 ? xmlIssues : [structuralIssue('Document is empty or not XML')],
    );
  }

  const country = detectCountry(root);
  if (country === 'BR') {
    const { document, issues } = parseBrazilXml(xml);
    if (!document) {
      return emptyResult('BR', [...xmlIssues, ...issues]);
    }
    const result = validateDocument(document, options);
    // XML-level problems belong alongside the business-rule problems: a
    // mismatched tag is a schema error, not a warning.
    return {
      ...result,
      issues: [...xmlIssues, ...result.issues].sort(severityRank),
      counts: recount([...xmlIssues, ...result.issues]),
      valid: result.valid && xmlIssues.length === 0,
    };
  }

  return emptyResult(country, [
    ...xmlIssues,
    structuralIssue(
      `Country "${country}" is not implemented yet. Brazil (NFS-e, NF-e) is supported. Peru (SUNAT) and EN16931 are planned.`,
    ),
  ]);
}

/** Validate a parsed document. */
export function validateDocument(
  document: InvoiceDocument,
  options: ValidateOptions = {},
): ValidationResult {
  switch (document.country) {
    case 'BR':
      return validateBrazilDocument(document, options);
    default:
      return emptyResult(document.country, [
        structuralIssue(
          `No validator for country "${document.country}". ShipReady validates Brazilian NFS-e and NF-e today.`,
        ),
      ]);
  }
}

/**
 * Correct what can be corrected without guessing.
 *
 * Only arithmetic and formatting. A tool that "fixes" a tax rate or invents a
 * document number produces an invoice that is wrong in a way the issuer does
 * not notice.
 */
export function fixInvoice(
  input: InvoiceDocument | string,
  options: ValidateOptions = {},
): FixResult {
  if (typeof input === 'string') {
    const { document } = parseBrazilXml(input);
    if (!document) {
      return { document: emptyDocument(), changes: 0, applied: [], remaining: 1 };
    }
    return fixBrazilDocument(document, options);
  }
  if (input.country !== 'BR') {
    return { document: input, changes: 0, applied: [], remaining: 1 };
  }
  return fixBrazilDocument(input, options);
}

/** Convert between formats. */
export function convertInvoice(
  input: InvoiceDocument | string,
  target: 'xml' | 'ubl' | 'csv' | 'json',
  options: { to?: CountryCode } = {},
): ConversionResult {
  let document: InvoiceDocument | null;

  if (typeof input === 'string') {
    const { root } = parseXml(input);
    const detected = root ? detectCountry(root) : 'EU';
    if (detected === 'BR') {
      document = parseBrazilXml(input).document;
    } else {
      return fromUbl({ root });
    }
  } else {
    document = input;
  }

  if (!document) {
    return {
      from: 'EU',
      to: options.to ?? 'EU',
      format: target === 'json' ? 'json' : target === 'csv' ? 'csv' : 'xml',
      output: '',
      unmapped: [
        { field: '/', value: 'unparseable document', reason: 'The input could not be parsed' },
      ],
      warnings: [],
    };
  }

  switch (target) {
    case 'csv':
      return toCsv(document);
    case 'json':
      return {
        from: document.country,
        to: document.country,
        format: 'json',
        output: JSON.stringify(document, null, 2),
        unmapped: [],
        warnings: [],
      };
    default:
      return toNfseXml(document);
  }
}

/**
 * Identify the country from the document.
 *
 * Detection is by root element and a couple of namespace markers rather than
 * by guessing from tax codes: a document can contain many tax codes and only
 * one issuer.
 */
export function detectCountry(root: {
  name: string;
  prefix?: string;
  children: { name: string; children: { name: string; text: string }[] }[];
}): CountryCode {
  const name = root.name.toLowerCase();
  if (
    name === 'nfse' ||
    name === 'nfs-e' ||
    name === 'compnfse' ||
    name === 'rps' ||
    name === 'nfe' ||
    name === 'infnfe'
  )
    return 'BR';
  if (root.prefix === 'nfe' || root.prefix === 'nfse' || root.prefix === 'cte') return 'BR';

  const text = JSON.stringify(root);
  if (/portalfiscal\.inf\.br|sped\.fazenda\.gov\.br/i.test(text)) return 'BR';
  if (/invoice|ubl/i.test(name)) return 'EU';
  if (/sunat|pe\.sunat\.gob\.pe/i.test(text)) return 'PE';
  return 'EU';
}

function severityRank(a: ValidationIssue, b: ValidationIssue): number {
  const rank = { error: 0, warning: 1, info: 2 };
  if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
  return a.path.localeCompare(b.path);
}

function recount(issues: readonly ValidationIssue[]): ValidationResult['counts'] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

function structuralIssue(message: string): ValidationIssue {
  return {
    ruleId: 'GENERAL/structure',
    severity: 'error',
    category: 'schema',
    path: '/',
    message,
    fixable: false,
  };
}

function emptyResult(country: CountryCode, issues: ValidationIssue[]): ValidationResult {
  const counts = recount(issues);
  let score = 100;
  for (const issue of issues)
    score -= issue.severity === 'error' ? 12 : issue.severity === 'warning' ? 4 : 1;
  return {
    valid: counts.error === 0,
    score: Math.max(0, score),
    issues: issues.sort(severityRank),
    counts,
    country,
    documentNumber: '',
    documentType: '',
    issuer: '',
    total: 0,
    currency: '',
    validatedAt: new Date().toISOString(),
    computed: null,
  };
}

function emptyDocument(): InvoiceDocument {
  return {
    country: 'BR',
    documentType: 'nfs-e',
    number: '',
    series: '',
    issueDate: '',
    currency: 'BRL',
    issuer: { document: '', name: '' },
    recipient: { document: '', name: '' },
    items: [],
    subtotal: 0,
    taxTotal: 0,
    total: 0,
    payments: [],
  };
}

/** Human-readable result. */
export function formatResult(result: ValidationResult): string {
  if (result.country === 'BR') return formatBrazilResult(result);

  const lines: string[] = [];
  lines.push(`[${result.valid ? 'VALID' : 'INVALID'}] ${result.country}`);
  lines.push(`Score: ${result.score}/100`);
  lines.push('');
  if (result.issues.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }
  for (const issue of result.issues) {
    const tag =
      issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARN ' : 'INFO ';
    lines.push(`${tag} ${issue.path}: ${issue.message}`);
    if (issue.expectation) lines.push(`       expected: ${issue.expectation}`);
  }
  return lines.join('\n');
}

/** Supported countries and document types, for `--help` and the dashboard. */
export const SUPPORTED: {
  country: CountryCode;
  name: string;
  documents: string[];
  mandate: string;
}[] = [
  {
    country: 'BR',
    name: 'Brazil',
    documents: ['NFS-e', 'NF-e', 'RPS', 'CompNfse'],
    mandate:
      'NFS-e became compulsory for micro and small businesses from September 2026 under the national standard (ADN 15/2023).',
  },
];

export { validateBrazilDocument, fixBrazilDocument, parseBrazilXml };
export type { BrazilOptions as ValidateBrazilOptions };
export { find, findAll, text, num, attr, parseXml };
export { round2 as roundMoney };
