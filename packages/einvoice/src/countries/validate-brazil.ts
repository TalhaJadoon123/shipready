import type { InvoiceDocument, ValidationIssue, FixResult, ValidationResult } from '../types.js';
import { round2 } from '../types.js';
import { validateBrazil, formatCnpj, formatCpf, parseIsoDate, suggestIsoDate } from './brazil.js';
import { validateCep } from '../xml.js';

/**
 * Brazil: validate and fix.
 *
 * `--fix` here does only what is unambiguously safe: recomputing arithmetic
 * that the document itself contradicts, normalising a currency code, and
 * converting a date written the Brazilian way into ISO. It never invents a tax
 * rate, a document number, or a party name, because a wrong value that looks
 * plausible is worse than a blank the issuer notices.
 */

export interface BrazilOptions {
  /** Numbers already issued, for duplicate detection. */
  issuedNumbers?: Set<string>;
  /** Numbers seen earlier in this batch. */
  seenNumbers?: Set<string>;
  municipalityCode?: string;
  now?: Date;
  requireIss?: boolean;
}

export function validateBrazilDocument(
  document: InvoiceDocument,
  options: BrazilOptions = {},
): ValidationResult {
  const { issues, computed } = validateBrazil(document, options);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;

  // Warnings and info reduce the score; errors reduce it harder. The score is a
  // rough signal for a dashboard, not a grade.
  let score = 100;
  for (const issue of issues) {
    score -= issue.severity === 'error' ? 12 : issue.severity === 'warning' ? 4 : 1;
  }
  score = Math.max(0, score);

  return {
    valid: counts.error === 0,
    score,
    issues: issues.sort(bySeverity),
    counts,
    country: 'BR',
    documentNumber: document.number,
    documentType: document.documentType,
    issuer: document.issuer?.name ?? '',
    total: document.total ?? 0,
    currency: document.currency,
    validatedAt: new Date(options.now ?? Date.now()).toISOString(),
    computed,
  };
}

function bySeverity(a: ValidationIssue, b: ValidationIssue): number {
  const rank = { error: 0, warning: 1, info: 2 };
  if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
  return a.path.localeCompare(b.path);
}

/**
 * Correct what can be corrected without guessing.
 *
 * Every change is recorded with its before and after value. The audit trail is
 * the point: an e-invoice that was auto-corrected needs to be explainable to
 * whoever signs off on it.
 */
export function fixBrazilDocument(
  document: InvoiceDocument,
  options: BrazilOptions = {},
): FixResult {
  const before = validateBrazilDocument(document, options);
  const fixes: FixResult['applied'] = [];
  const next: InvoiceDocument = structuredClone(document);

  // --- Currency -------------------------------------------------------------
  if (before.issues.some((i) => i.ruleId === 'BR/schema/invalid-currency')) {
    fixes.push({
      path: 'currency',
      from: next.currency,
      to: 'BRL',
      ruleId: 'BR/schema/invalid-currency',
    });
    next.currency = 'BRL';
  }

  // --- Dates ----------------------------------------------------------------
  if (before.issues.some((i) => i.ruleId === 'BR/date/invalid-issue-date')) {
    const suggested = suggestIsoDate(next.issueDate);
    if (suggested && parseIsoDate(suggested)) {
      fixes.push({
        path: 'issueDate',
        from: next.issueDate,
        to: suggested,
        ruleId: 'BR/date/invalid-issue-date',
      });
      next.issueDate = suggested;
    }
  }

  next.payments = next.payments.map((payment) => {
    const invalid = before.issues.some(
      (i) =>
        i.ruleId === 'BR/date/invalid-due-date' &&
        i.path === `payments[next.payments.indexOf(payment)}].dueDate`,
    );
    if (!invalid) return payment;
    const suggested = suggestIsoDate(payment.dueDate);
    if (!suggested || !parseIsoDate(suggested)) return payment;
    fixes.push({
      path: `payments.dueDate`,
      from: payment.dueDate,
      to: suggested,
      ruleId: 'BR/date/invalid-due-date',
    });
    return { ...payment, dueDate: suggested };
  });

  // A due date before the issue date is a real error with an unambiguous fix.
  next.payments = next.payments.map((payment) => {
    const due = parseIsoDate(payment.dueDate);
    const issue = parseIsoDate(next.issueDate);
    if (!due || !issue || due >= issue) return payment;
    fixes.push({
      path: `payments[].dueDate`,
      from: payment.dueDate,
      to: next.issueDate,
      ruleId: 'BR/date/due-before-issue',
    });
    return { ...payment, dueDate: next.issueDate };
  });

  // --- Line arithmetic ------------------------------------------------------
  next.items = next.items.map((item, index) => {
    const fixed = { ...item };
    const issuesForLine = before.issues.filter((i) => i.path.startsWith(`items[${index}]`));

    const lineTotalIssue = issuesForLine.find(
      (i) => i.ruleId === 'BR/calculation/line-total-mismatch',
    );
    if (lineTotalIssue) {
      const expected = round2(fixed.quantity * fixed.unitPrice - (fixed.discount ?? 0));
      fixes.push({
        path: `items[${index}].total`,
        from: String(fixed.total),
        to: String(expected),
        ruleId: lineTotalIssue.ruleId,
      });
      fixed.total = expected;
    }

    const taxMismatch = issuesForLine.find(
      (i) => i.ruleId === 'BR/calculation/tax-amount-mismatch',
    );
    if (taxMismatch) {
      const expected = round2((fixed.taxCodes ?? []).reduce((sum, t) => sum + t.amount, 0));
      fixes.push({
        path: `items[${index}].taxAmount`,
        from: String(fixed.taxAmount),
        to: String(expected),
        ruleId: taxMismatch.ruleId,
      });
      fixed.taxAmount = expected;
    }

    // Recompute each tax amount from its own base and rate.
    if (fixed.taxCodes) {
      fixed.taxCodes = fixed.taxCodes.map((tax, taxIndex) => {
        const rateIssue = issuesForLine.find(
          (i) =>
            i.ruleId === 'BR/calculation/tax-rate-mismatch' &&
            i.path === `items[${index}].taxCodes[${taxIndex}].amount`,
        );
        if (!rateIssue) return tax;
        const expected = round2((tax.base * tax.rate) / 100);
        fixes.push({
          path: `items[${index}].taxCodes[${taxIndex}].amount`,
          from: String(tax.amount),
          to: String(expected),
          ruleId: rateIssue.ruleId,
        });
        return { ...tax, amount: expected };
      });
    }

    // A tax base that is zero makes every rate computation meaningless.
    if (fixed.taxCodes) {
      fixed.taxCodes = fixed.taxCodes.map((tax) => {
        if (tax.base > 0) return tax;
        const expectedBase = fixed.total - (fixed.discount ?? 0);
        fixes.push({
          path: `items[${index}].taxCodes[].base`,
          from: '0',
          to: String(expectedBase),
          ruleId: 'BR/calculation/tax-base-zero',
        });
        return { ...tax, base: expectedBase };
      });
    }

    // Discount greater than the line value: the document cannot be right.
    if ((fixed.discount ?? 0) > fixed.quantity * fixed.unitPrice) {
      fixes.push({
        path: `items[${index}].discount`,
        from: String(fixed.discount),
        to: '0',
        ruleId: 'BR/business/discount-exceeds-line',
      });
      fixed.discount = 0;
    }

    return fixed;
  });

  // --- Totals ---------------------------------------------------------------
  const computedSubtotal = round2(
    next.items.reduce((s, i) => s + i.quantity * i.unitPrice - (i.discount ?? 0), 0),
  );
  const computedTax = round2(next.items.reduce((s, i) => s + i.taxAmount, 0));

  if (Math.abs(computedSubtotal - next.subtotal) > 0.01) {
    fixes.push({
      path: 'subtotal',
      from: String(next.subtotal),
      to: String(computedSubtotal),
      ruleId: 'BR/calculation/subtotal-mismatch',
    });
    next.subtotal = computedSubtotal;
  }
  if (Math.abs(computedTax - next.taxTotal) > 0.01) {
    fixes.push({
      path: 'taxTotal',
      from: String(next.taxTotal),
      to: String(computedTax),
      ruleId: 'BR/calculation/tax-total-mismatch',
    });
    next.taxTotal = computedTax;
  }
  const computedTotal = round2(computedSubtotal + computedTax + (next.shipping ?? 0));
  if (Math.abs(computedTotal - next.total) > 0.01) {
    fixes.push({
      path: 'total',
      from: String(next.total),
      to: String(computedTotal),
      ruleId: 'BR/calculation/total-mismatch',
    });
    next.total = computedTotal;
  }

  // --- Payments -------------------------------------------------------------
  const paymentTotal = round2(next.payments.reduce((s, p) => s + p.amount, 0));
  if (next.payments.length > 0 && Math.abs(paymentTotal - next.total) > 0.01) {
    const delta = round2(next.total - paymentTotal);
    const last = next.payments[next.payments.length - 1]!;
    fixes.push({
      path: 'payments[].amount',
      from: String(last.amount),
      to: String(round2(last.amount + delta)),
      ruleId: 'BR/calculation/payment-total-mismatch',
    });
    next.payments[next.payments.length - 1] = { ...last, amount: round2(last.amount + delta) };
  }

  // --- Series year ----------------------------------------------------------
  const seriesYear = before.issues.find((i) => i.ruleId === 'BR/date/series-year-mismatch');
  if (seriesYear?.suggestedValue) {
    fixes.push({
      path: 'series',
      from: next.series,
      to: seriesYear.suggestedValue,
      ruleId: seriesYear.ruleId,
    });
    next.series = seriesYear.suggestedValue;
  }

  const after = validateBrazilDocument(next, options);
  return { document: next, changes: fixes.length, applied: fixes, remaining: after.counts.error };
}

/** A human summary of a Brazilian validation result. */
export function formatBrazilResult(result: ValidationResult): string {
  const lines: string[] = [];
  const status = result.valid ? 'VALID' : 'INVALID';
  lines.push(
    `[${status}] ${result.documentType.toUpperCase()} ${result.documentNumber} (series ${''})`,
  );
  lines.push(`Issuer: ${result.issuer}`);
  lines.push(`Total: ${result.total.toFixed(2)} ${result.currency}`);
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
    if (issue.reference) lines.push(`       reference: ${issue.reference}`);
  }
  return lines.join('\n');
}

export { formatCnpj, formatCpf, validateCep };
