import { ISS_TAX_CATALOGUE, type ISS_TAX_CATALOGUE_ENTRY } from './iss-taxes.js';
import type { InvoiceDocument, TaxCode, ValidationIssue } from '../types.js';
import { round2, round4 } from '../types.js';
/**
 * Brazil: NFS-e (Nota Fiscal de Servico Eletronica) for small and micro
 * businesses, and NF-e (Nota Fiscal Eletronica) for goods.
 *
 * Why Brazil: the national NFS-e standard (ADN 15/2023) made electronic service
 * invoices compulsory for micro and small businesses from September 2026, which
 * puts a large population of very small companies onto a standard most of them
 * have never used. That is the underserved niche this package is built for.
 *
 * Everything here is derived from the published schemas and manual norms. We
 * validate and convert. We do not clear against SEFAZ, and we must not be
 * understood to: clearance requires certification as a technical provider and
 * carries liability that a validation tool has no business taking on.
 */
// ---------------------------------------------------------------------------
// Tax codes (tributos municipalities)
// ---------------------------------------------------------------------------
/** An ISS tax code from LC 116/2003, Anexo I. Defined in iss-taxes.ts. */
export type BrazilianTax = ISS_TAX_CATALOGUE_ENTRY;
/**
 * ISS tax codes, keyed by the five-digit national code used in NFS-e.
 *
 * The rate is genuinely variable for every entry: the municipality sets it
 * under LC 116/2003 and it ranges from 2% to 5%. Shipping one number as fact
 * would produce wrong totals in most municipalities, so `kind` is `variable`
 * throughout and the validator reports a deviation rather than an error.
 */
export const ISS_TAXES: Record<string, BrazilianTax> = ISS_TAX_CATALOGUE;
/**
 * The simplified national ISS rate.
 *
 * Several municipalities adopted 2% under the LC 157/2016 "fator 20" option.
 * Where a municipality has not, the rate is 5%. We cannot know which, so the
 * validator reports a deviation from the default rather than asserting an error:
 * a wrong number here means someone underpays their municipality tax.
 */
export const SIMPLIFIED_ISS_RATE = 2;
export const FULL_ISS_RATE = 5;
// ---------------------------------------------------------------------------
// UoM codes
// ---------------------------------------------------------------------------
/**
 * UN/ECE Recommendation 20 unit-of-measure codes.
 *
 * The full list runs to several hundred entries; these are the codes that
 * actually appear on a Brazilian invoice. `HUR` (hora) is worth naming
 * explicitly because every hourly services invoice uses it, and it is the
 * code most often rejected by a validator that forgot it.
 */
export const VALID_UOM = new Set([
  // Count
  'UND', 'UN', 'PC', 'CX', 'DZ', 'PCT', 'FD', 'SC', 'HS', 'ORC', 'CT', 'SET', 'PACK', 'BL',
  // Mass
  'G', 'KGM', 'KG', 'MG', 'T', 'TON', 'LB', 'LBR', 'OZ', 'GRM', 'MTQ', 'UG',
  // Length and area
  'M', 'CM', 'MM', 'M2', 'M2W', 'M3', 'KM', 'MTK', 'FTQ', 'FT2', 'FT3', 'INH', 'YRD', 'MLT',
  // Volume
  'L', 'LTR', 'ML', 'LIT', 'M3', 'M3W',
  // Time
  'HUR', 'HR', 'H', 'DAY', 'MO', 'MON', 'MIN', 'WEE', 'ANN', 'SEC',
  // Energy and information
  'KWH', 'MWH', 'GWH', 'MB', 'KMT', 'MMT', 'LS', 'GX', 'AD',
]);
// ---------------------------------------------------------------------------
// Tax regimes (Simples Nacional)
// ---------------------------------------------------------------------------
export const TAX_REGIMES: Record<string, string> = {
  '1': 'Simples Nacional',
  '2': 'Simples Nacional - excesso de sublimite da receita bruta',
  '3': 'Regime Normal',
};
/**
 * Federal taxes that commonly appear on a Brazilian service invoice, even
 * though NFS-e carries municipal ISS. The validator checks the codes but does
 * not compute the rate: federal rates depend on regime and are out of scope.
 */
export const FEDERAL_TAX_CODES: Record<string, string> = {
  '0001': 'IRPJ',
  '0002': 'CSLL',
  '0499': 'ISS及其他',
};
// ---------------------------------------------------------------------------
// Validation rules
// ---------------------------------------------------------------------------
export interface BrazilValidationOptions {
  /** Duplicates already seen, for `duplicate-number` checks. */
  seenNumbers?: Set<string>;
  /** Issued numbers retained for cross-document duplicate detection. */
  issuedNumbers?: Set<string>;
  /** Municipality code (IBGE, 7 digits), where known. */
  municipalityCode?: string;
  /** Reference date for age checks. Defaults to now. */
  now?: Date;
  /** Warn when ISS is missing even if no other issue is found. */
  requireIss?: boolean;
}
/**
 * Validate a Brazilian NFS-e or NF-e.
 *
 * Rules are ordered so that the cheapest structural checks run first: a
 * document with a missing CNPJ will produce a hundred downstream errors, and
 * reporting a hundred is worse than reporting the one thing to fix.
 */
export function validateBrazil(
  document: InvoiceDocument,
  options: BrazilValidationOptions = {},
): {
  issues: ValidationIssue[];
  computed: { subtotal: number; taxTotal: number; total: number };
} {
  const issues: ValidationIssue[] = [];
  const now = options.now ?? new Date();
  const isServiceInvoice =
    document.documentType.toLowerCase().includes('nfs') || document.items.some((i) => i.isService);
  // --- Identity -------------------------------------------------------------
  const cnpj = validateCnpj(document.issuer?.document ?? '');
  if (!cnpj.valid) {
    issues.push({
      ruleId: 'BR/identity/invalid-cnpj',
      severity: 'error',
      category: 'format',
      path: 'issuer.document',
      message: cnpj.reason,
      expectation: 'CNPJ is 14 digits and passes the check-digit test',
      actual: document.issuer?.document,
      fixable: false,
      reference: 'CNPJ check digit algorithm (Módulo 11)',
    });
  }
  const recipientDoc = document.recipient?.document ?? '';
  // A consumer invoice may legitimately have no CNPJ, but not an empty string
  // where a company document was expected.
  if (recipientDoc !== '') {
    const isCpf = validateCpf(recipientDoc);
    const isCnpj = validateCnpj(recipientDoc);
    if (!isCpf.valid && !isCnpj.valid) {
      issues.push({
        ruleId: 'BR/identity/invalid-recipient-document',
        severity: 'error',
        category: 'format',
        path: 'recipient.document',
        message: 'Recipient document is neither a valid CPF nor a valid CNPJ',
        expectation: 'CNPJ (14 digits) or CPF (11 digits)',
        actual: recipientDoc,
        fixable: false,
      });
    }
  } else {
    issues.push({
      ruleId: 'BR/identity/missing-recipient-document',
      severity: 'warning',
      category: 'required-field',
      path: 'recipient.document',
      message: 'Recipient has no CPF or CNPJ. Required for B2B; optional for a consumer invoice.',
      expectation: 'CNPJ or CPF, or an explicit consumer marker',
      fixable: false,
    });
  }
  if (document.documentType !== 'nfs-e' && !document.documentType.toLowerCase().includes('nf')) {
    issues.push({
      ruleId: 'BR/schema/unsupported-document-type',
      severity: 'warning',
      category: 'schema',
      path: 'documentType',
      message: `Document type "${document.documentType}" is not a recognised Brazilian fiscal document`,
      expectation: 'nfe, nfce, nfs-e, ct-e',
      fixable: false,
    });
  }
  // --- Numbering ------------------------------------------------------------
  if (!/^\d{1,15}$/.test(String(document.number).padStart(1, ''))) {
    issues.push({
      ruleId: 'BR/schema/invalid-number',
      severity: 'error',
      category: 'format',
      path: 'number',
      message: `Invoice number "${document.number}" is not numeric`,
      expectation: 'digits only, up to 15 characters',
      actual: String(document.number),
      fixable: false,
    });
  }
  if (document.number && !document.series) {
    issues.push({
      ruleId: 'BR/required/missing-series',
      severity: 'error',
      category: 'required-field',
      path: 'series',
      message: 'Invoice series is required',
      expectation: 'a series string, normally numeric',
      fixable: false,
    });
  }
  // --- Dates ----------------------------------------------------------------
  const issueDate = parseIsoDate(document.issueDate);
  if (!issueDate) {
    issues.push({
      ruleId: 'BR/date/invalid-issue-date',
      severity: 'error',
      category: 'format',
      path: 'issueDate',
      message: `"${document.issueDate}" is not a valid ISO date`,
      expectation: 'YYYY-MM-DD',
      actual: document.issueDate,
      fixable: true,
      suggestedValue: suggestIsoDate(document.issueDate),
    });
  } else {
    if (issueDate.getTime() > now.getTime() + 86_400_000) {
      issues.push({
        ruleId: 'BR/date/future-issue-date',
        severity: 'error',
        category: 'date-range',
        path: 'issueDate',
        message: `Issue date ${document.issueDate} is in the future`,
        expectation: 'a date not later than today',
        actual: document.issueDate,
        fixable: false,
        reference: 'NT 2023.001',
      });
    }
    const oldest = new Date(now.getTime() - 10 * 365 * 86_400_000);
    if (issueDate < oldest) {
      issues.push({
        ruleId: 'BR/date/issue-date-too-old',
        severity: 'warning',
        category: 'date-range',
        path: 'issueDate',
        message: `Issue date ${document.issueDate} is more than ten years old`,
        expectation: 'within the statutory retention window',
        actual: document.issueDate,
        fixable: false,
      });
    }
    const year = issueDate.getUTCFullYear();
    if (document.series && /^\d{2}$/.test(document.series)) {
      issues.push({
        ruleId: 'BR/date/series-year-mismatch',
        severity: 'warning',
        category: 'business-rule',
        path: 'series',
        message: `Series "${document.series}" encodes a year that does not match the issue date`,
        expectation: `series year ${String(year).slice(2)}`,
        actual: document.series,
        fixable: true,
        suggestedValue: String(year).slice(2),
      });
    }
  }
  // An ISO 4217 code is three letters. The digit check exists because some
// // municipal layouts pad the currency into a numeric field.
if (!/^[A-Z]{3}$/.test(document.currency) && !/^\d{3}$/.test(document.currency)) {
    issues.push({
      ruleId: 'BR/schema/invalid-currency',
      severity: 'error',
      category: 'format',
      path: 'currency',
      message: `Currency "${document.currency}" is not an ISO 4217 code`,
      expectation: 'BRL for a domestic invoice',
      actual: document.currency,
      fixable: true,
      suggestedValue: 'BRL',
    });
  } else if (document.currency !== 'BRL') {
    issues.push({
      ruleId: 'BR/business-rule/foreign-currency',
      severity: 'warning',
      category: 'business-rule',
      path: 'currency',
      message: `Invoice is in ${document.currency}. A Brazilian domestic invoice is normally BRL; otherwise the exchange rate must be stated.`,
      expectation: 'BRL, or a stated exchange rate',
      fixable: false,
    });
  }
  // --- Duplicate detection --------------------------------------------------
  const dedupeKey = `${document.issuer?.document ?? ''}|${document.series}|${document.number}`;
  if (options.seenNumbers?.has(dedupeKey)) {
    issues.push({
      ruleId: 'BR/duplicate/repeated-number',
      severity: 'error',
      category: 'duplicate',
      path: 'number',
      message: `Invoice number ${document.number} series ${document.series} has already been seen in this batch`,
      expectation: 'a number not previously issued by this issuer',
      fixable: false,
      reference: 'NT 2023.001, uniqueness rule',
    });
  }
  if (options.issuedNumbers?.has(dedupeKey)) {
    issues.push({
      ruleId: 'BR/duplicate/already-issued',
      severity: 'error',
      category: 'duplicate',
      path: 'number',
      message: `Invoice number ${document.number} series ${document.series} was already issued`,
      expectation: 'a number not previously issued',
      fixable: false,
    });
  }
  // --- Items ---------------------------------------------------------------
  if (!document.items || document.items.length === 0) {
    issues.push({
      ruleId: 'BR/required/no-items',
      severity: 'error',
      category: 'required-field',
      path: 'items',
      message: 'Invoice has no line items',
      expectation: 'at least one line item',
      fixable: false,
    });
    return { issues, computed: { subtotal: 0, taxTotal: 0, total: 0 } };
  }
  const computedSubtotal = round2(
    document.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice - (item.discount ?? 0),
      0,
    ),
  );
  const computedTax = round2(document.items.reduce((sum, item) => sum + item.taxAmount, 0));
  document.items.forEach((item, index) => {
    const path = `items[${index}]`;
    if (!item.description || item.description.trim().length === 0) {
      issues.push({
        ruleId: 'BR/required/missing-item-description',
        severity: 'error',
        category: 'required-field',
        path: `${path}.description`,
        message: 'Line item has no description',
        expectation: 'a non-empty description',
        fixable: false,
      });
    }
    if (!(item.quantity > 0)) {
      issues.push({
        ruleId: 'BR/business/invalid-quantity',
        severity: 'error',
        category: 'business-rule',
        path: `${path}.quantity`,
        message: `Quantity ${item.quantity} must be greater than zero`,
        expectation: 'a positive number, up to 4 decimal places',
        actual: String(item.quantity),
        fixable: false,
        reference: 'NT 2023.001, quantity field',
      });
    }
    if (
      item.quantity > 0 &&
      round2(Math.abs(item.quantity * 1000) % 1) !== 0 &&
      (String(item.quantity).split('.')[1] ?? '').length > 3
    ) {
      issues.push({
        ruleId: 'BR/business/quantity-precision',
        severity: 'warning',
        category: 'business-rule',
        path: `${path}.quantity`,
        message: `Quantity ${item.quantity} has more than 3 decimal places`,
        expectation: 'up to 3 decimal places',
        fixable: false,
      });
    }
    if (!item.unit || !VALID_UOM.has(item.unit.toUpperCase())) {
      issues.push({
        ruleId: 'BR/format/invalid-uom',
        severity: 'error',
        category: 'format',
        path: `${path}.unit`,
        message: `Unit of measure "${item.unit}" is not a valid UN/ECE 20 code`,
        expectation: 'a code such as UND, HUR, KGM, M2',
        actual: item.unit,
        fixable: false,
        reference: 'UN/ECE Recommendation 20',
      });
    }
    if (!(item.unitPrice >= 0)) {
      issues.push({
        ruleId: 'BR/business/invalid-unit-price',
        severity: 'error',
        category: 'business-rule',
        path: `${path}.unitPrice`,
        message: `Unit price ${item.unitPrice} is negative or not a number`,
        expectation: 'zero or greater',
        actual: String(item.unitPrice),
        fixable: false,
      });
    }
    if (item.unitPrice === 0) {
      issues.push({
        ruleId: 'BR/business/zero-unit-price',
        severity: 'warning',
        category: 'business-rule',
        path: `${path}.unitPrice`,
        message:
          'Line item has a zero unit price. This is legal for a promotional line but unusual.',
        expectation: 'a non-zero price, or an explicit promotional flag',
        fixable: false,
      });
    }
    // Line total: quantity x unit price, less discount.
    const expectedLineTotal = round2(item.quantity * item.unitPrice - (item.discount ?? 0));
    if (Math.abs(expectedLineTotal - item.total) > 0.01) {
      issues.push({
        ruleId: 'BR/calculation/line-total-mismatch',
        severity: 'error',
        category: 'calculation',
        path: `${path}.total`,
        message: `Line total ${formatNumber(item.total)} does not equal quantity x unit price less discount (${formatNumber(expectedLineTotal)})`,
        expectation: formatNumber(expectedLineTotal),
        actual: formatNumber(item.total),
        fixable: true,
        suggestedValue: expectedLineTotal.toFixed(2),
      });
    }
    if ((item.discount ?? 0) > item.quantity * item.unitPrice) {
      issues.push({
        ruleId: 'BR/business/discount-exceeds-line',
        severity: 'error',
        category: 'business-rule',
        path: `${path}.discount`,
        message: 'Line discount exceeds the line value',
        expectation: 'discount no greater than quantity x unit price',
        fixable: true,
        suggestedValue: '0.00',
      });
    }
    // Tax codes.
    if (!item.taxCodes || item.taxCodes.length === 0) {
      if (options.requireIss !== false || isServiceInvoice) {
        issues.push({
          ruleId: 'BR/tax/missing-tax-code',
          severity: 'error',
          category: 'tax-code',
          path: `${path}.taxCodes`,
          message: 'Line item has no tax code. A service invoice requires at least one ISS code.',
          expectation: 'at least one tax code',
          fixable: false,
          reference: 'LC 116/2003; ADN 15/2023',
        });
      } else {
        issues.push({
          ruleId: 'BR/tax/missing-tax-code',
          severity: 'warning',
          category: 'tax-code',
          path: `${path}.taxCodes`,
          message: 'Line item has no tax code',
          expectation: 'at least one tax code',
          fixable: false,
        });
      }
    } else {
      item.taxCodes.forEach((tax, taxIndex) => {
        checkBrazilianTax(tax, `${path}.taxCodes[${taxIndex}]`, issues, isServiceInvoice);
      });
    }
    const expectedTax = round2(item.taxCodes.reduce((sum, tax) => sum + tax.amount, 0));
    if (Math.abs(expectedTax - item.taxAmount) > 0.01) {
      issues.push({
        ruleId: 'BR/calculation/tax-amount-mismatch',
        severity: 'error',
        category: 'calculation',
        path: `${path}.taxAmount`,
        message: `Line tax total ${formatNumber(item.taxAmount)} does not equal the sum of its tax codes (${formatNumber(expectedTax)})`,
        expectation: formatNumber(expectedTax),
        actual: formatNumber(item.taxAmount),
        fixable: true,
        suggestedValue: expectedTax.toFixed(2),
      });
    }
    // Rate x base must equal amount.
    for (const [taxIndex, tax] of (item.taxCodes ?? []).entries()) {
      const expectedFromRate = round2((tax.base * tax.rate) / 100);
      if (Math.abs(expectedFromRate - tax.amount) > 0.01) {
        issues.push({
          ruleId: 'BR/calculation/tax-rate-mismatch',
          severity: 'error',
          category: 'calculation',
          path: `${path}.taxCodes[${taxIndex}].amount`,
          message: `Tax amount ${formatNumber(tax.amount)} does not equal base x rate (${formatNumber(expectedFromRate)})`,
          expectation: formatNumber(expectedFromRate),
          actual: formatNumber(tax.amount),
          fixable: true,
          suggestedValue: expectedFromRate.toFixed(2),
        });
      }
    }
    if (isServiceInvoice && item.isService && !item.serviceCode) {
      issues.push({
        ruleId: 'BR/required/missing-service-code',
        severity: 'warning',
        category: 'required-field',
        path: `${path}.serviceCode`,
        message:
          'Service line has no service code. Required by the national NFS-e standard for some item lists.',
        expectation: 'the national service code',
        fixable: false,
        reference: 'ADN 15/2023',
      });
    }
  });
  // --- Totals --------------------------------------------------------------
  if (Math.abs(computedSubtotal - document.subtotal) > 0.01) {
    issues.push({
      ruleId: 'BR/calculation/subtotal-mismatch',
      severity: 'error',
      category: 'calculation',
      path: 'subtotal',
      message: `Subtotal ${formatNumber(document.subtotal)} does not equal the sum of line items (${formatNumber(computedSubtotal)})`,
      expectation: formatNumber(computedSubtotal),
      actual: formatNumber(document.subtotal),
      fixable: true,
      suggestedValue: computedSubtotal.toFixed(2),
    });
  }
  if (Math.abs(computedTax - document.taxTotal) > 0.01) {
    issues.push({
      ruleId: 'BR/calculation/tax-total-mismatch',
      severity: 'error',
      category: 'calculation',
      path: 'taxTotal',
      message: `Tax total ${formatNumber(document.taxTotal)} does not equal the sum of line taxes (${formatNumber(computedTax)})`,
      expectation: formatNumber(computedTax),
      actual: formatNumber(document.taxTotal),
      fixable: true,
      suggestedValue: computedTax.toFixed(2),
    });
  }
  const expectedGrandTotal = round2(computedSubtotal + computedTax + (document.shipping ?? 0));
  if (Math.abs(expectedGrandTotal - document.total) > 0.01) {
    issues.push({
      ruleId: 'BR/calculation/total-mismatch',
      severity: 'error',
      category: 'calculation',
      path: 'total',
      message: `Total ${formatNumber(document.total)} does not equal subtotal plus tax plus shipping (${formatNumber(expectedGrandTotal)})`,
      expectation: formatNumber(expectedGrandTotal),
      actual: formatNumber(document.total),
      fixable: true,
      suggestedValue: expectedGrandTotal.toFixed(2),
    });
  }
  if (document.total < 0) {
    issues.push({
      ruleId: 'BR/business/negative-total',
      severity: 'error',
      category: 'business-rule',
      path: 'total',
      message: 'Invoice total is negative. Use a credit note instead.',
      expectation: 'zero or greater',
      fixable: false,
    });
  }
  // --- Payments ------------------------------------------------------------
  if (!document.payments || document.payments.length === 0) {
    issues.push({
      ruleId: 'BR/required/no-payment-terms',
      severity: 'warning',
      category: 'required-field',
      path: 'payments',
      message: 'Invoice states no payment terms. The recipient cannot tell when it is due.',
      expectation: 'at least one payment term',
      fixable: false,
    });
  } else {
    const paymentTotal = round2(document.payments.reduce((sum, p) => sum + p.amount, 0));
    if (Math.abs(paymentTotal - document.total) > 0.01) {
      issues.push({
        ruleId: 'BR/calculation/payment-total-mismatch',
        severity: 'error',
        category: 'calculation',
        path: 'payments',
        message: `Payment terms total ${formatNumber(paymentTotal)} does not equal the invoice total (${formatNumber(document.total)})`,
        expectation: formatNumber(document.total),
        actual: formatNumber(paymentTotal),
        fixable: true,
        suggestedValue: (document.total - paymentTotal).toFixed(2),
      });
    }
    document.payments.forEach((payment, index) => {
      const due = parseIsoDate(payment.dueDate);
      if (!due) {
        issues.push({
          ruleId: 'BR/date/invalid-due-date',
          severity: 'error',
          category: 'format',
          path: `payments[${index}].dueDate`,
          message: `"${payment.dueDate}" is not a valid ISO date`,
          expectation: 'YYYY-MM-DD',
          fixable: true,
          suggestedValue: suggestIsoDate(payment.dueDate),
        });
      } else if (issueDate && due < issueDate) {
        issues.push({
          ruleId: 'BR/date/due-before-issue',
          severity: 'error',
          category: 'date-range',
          path: `payments[${index}].dueDate`,
          message: `Due date ${payment.dueDate} precedes the issue date`,
          expectation: 'a date on or after the issue date',
          fixable: true,
          suggestedValue: document.issueDate,
        });
      }
    });
  }
  // --- Service invoice specifics ------------------------------------------
  if (isServiceInvoice && !document.serviceDescription) {
    issues.push({
      ruleId: 'BR/required/missing-service-description',
      severity: 'warning',
      category: 'required-field',
      path: 'serviceDescription',
      message: 'Service invoice has no service description. Many municipalities require one.',
      expectation: 'a description of the service rendered',
      fixable: false,
      reference: 'LC 116/2003, art. 2',
    });
  }
  if (
    isServiceInvoice &&
    document.issuer?.municipalRegistration !== undefined &&
    !/^\d{2,15}$/.test(document.issuer.municipalRegistration)
  ) {
    issues.push({
      ruleId: 'BR/format/invalid-inscricao-municipal',
      severity: 'warning',
      category: 'format',
      path: 'issuer.municipalRegistration',
      message:
        'Municipal registration (Inscrição Municipal) is not alphanumeric-numeric as expected',
      expectation: 'the municipal tax registration number',
      fixable: false,
    });
  }
  return {
    issues,
    computed: { subtotal: computedSubtotal, taxTotal: computedTax, total: expectedGrandTotal },
  };
}
function checkBrazilianTax(
  tax: TaxCode,
  path: string,
  issues: ValidationIssue[],
  isServiceInvoice: boolean,
): void {
  const known = ISS_TAXES[tax.code];
  if (!known && !FEDERAL_TAX_CODES[tax.code]) {
    issues.push({
      ruleId: 'BR/tax/unknown-tax-code',
      severity: isServiceInvoice ? 'error' : 'warning',
      category: 'tax-code',
      path: `${path}.code`,
      message: `Tax code "${tax.code}" is not in the ISS list or the federal tax list`,
      expectation: 'a five-digit ISS code from LC 116/2003, or a federal code',
      actual: tax.code,
      fixable: false,
      reference: 'LC 116/2003, Anexo I',
    });
  }
  if (!(tax.rate > 0)) {
    issues.push({
      ruleId: 'BR/tax/invalid-rate',
      severity: 'error',
      category: 'tax-code',
      path: `${path}.rate`,
      message: `Tax rate ${tax.rate} must be greater than zero`,
      expectation: 'a rate above zero; use a zero-rate code (exportação, por exemplo) instead',
      fixable: false,
    });
  }
  if (tax.rate > 40) {
    issues.push({
      ruleId: 'BR/tax/rate-out-of-range',
      severity: 'warning',
      category: 'tax-code',
      path: `${path}.rate`,
      message: `Tax rate ${tax.rate}% is above any municipal ISS rate. Check for a decimal-point error.`,
      expectation: 'at most 5% ISS, or a federal code with its own rate',
      fixable: false,
    });
  }
  if (known && known.kind === 'variable' && tax.rate !== known.rate) {
    issues.push({
      ruleId: 'BR/tax/rate-differs-from-default',
      severity: 'info',
      category: 'tax-code',
      path: `${path}.rate`,
      message: `ISS code ${tax.code} (${known.name}) is commonly ${known.rate}%, but this invoice uses ${tax.rate}%. That may be correct for your municipality.`,
      expectation: `${known.rate}% unless your municipality legislates otherwise`,
      fixable: false,
      reference: known.law,
    });
  }
}
// ---------------------------------------------------------------------------
// Check digits
// ---------------------------------------------------------------------------
/**
 * CNPJ check digit.
 *
 * Two digits computed with the standard Brazilian modulo-11 weighting. A CNPJ
 * that fails here is almost always a typo, and the SEFAZ rejects it outright.
 */
export function validateCnpj(value: string): { valid: boolean; reason: string } {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 14) {
    return { valid: false, reason: `CNPJ must have 14 digits, found ${digits.length}` };
  }
  if (/^(\d)\1{13}$/.test(digits)) {
    return { valid: false, reason: 'CNPJ cannot be all the same digit' };
  }
  const first = checkDigit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 11);
  const second = checkDigit(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 11);
  if (digits.charAt(12) !== String(first) || digits.charAt(13) !== String(second)) {
    return { valid: false, reason: 'CNPJ check digits do not match' };
  }
  return { valid: true, reason: '' };
}
/** CPF check digit: the same modulo-11 construction. */
export function validateCpf(value: string): { valid: boolean; reason: string } {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 11) {
    return { valid: false, reason: `CPF must have 11 digits, found ${digits.length}` };
  }
  if (/^(\d)\1{10}$/.test(digits)) {
    return { valid: false, reason: 'CPF cannot be all the same digit' };
  }
  const first = checkDigit(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2], 11);
  const second = checkDigit(digits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], 11);
  if (digits.charAt(9) !== String(first) || digits.charAt(10) !== String(second)) {
    return { valid: false, reason: 'CPF check digits do not match' };
  }
  return { valid: true, reason: '' };
}
function checkDigit(digits: string, weights: readonly number[], modulus: number): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * weights[i]!;
  const remainder = sum % modulus;
  return remainder < 2 ? 0 : modulus - remainder;
}
/** Format a document for display: `12.345.678/0001-95`. */
export function formatCnpj(value: string): string {
  const d = String(value).replace(/\D/g, '').padStart(14, '0');
  if (d.length !== 14) return value;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
export function formatCpf(value: string): string {
  const d = String(value).replace(/\D/g, '').padStart(11, '0');
  if (d.length !== 11) return value;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Reject 2026-02-31 and similar, which Date silently rolls over.
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}
export function suggestIsoDate(value: string): string | undefined {
  // Accepts Brazilian DD/MM/YYYY and returns ISO.
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value).trim());
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  if (us) {
    const [, a, b, y] = us;
    const month = Number(a) > 12 ? b : a;
    const day = Number(a) > 12 ? a : b;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(String(value).trim());
  if (compact) return `${compact[3]}-${compact[2]}-${compact[1]}`;
  return undefined;
}
export function formatNumber(n: number): string {
  return round4(n).toFixed(2);
}
export type { InvoiceDocument };
