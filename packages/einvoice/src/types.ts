/**
 * Invoice model, shared by every country implementation.
 *
 * Deliberately not country-specific: the point of the model is that a validator
 * for Peru and a validator for Brazil read the same shapes, and a converter
 * between them is a mapping rather than a translation.
 */

export type CountryCode = 'BR' | 'PE' | 'EU';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationCategory =
  | 'schema'
  | 'required-field'
  | 'format'
  | 'business-rule'
  | 'calculation'
  | 'tax-code'
  | 'duplicate'
  | 'date-range'
  | 'conformance';

export interface ValidationIssue {
  /** Stable rule id, e.g. `BR/tax/invalid-cst`. */
  ruleId: string;
  severity: ValidationSeverity;
  category: ValidationCategory;
  /** Dotted path to the offending field. */
  path: string;
  message: string;
  /** What a compliant value looks like. */
  expectation?: string;
  /** The value that failed, truncated. Never the full document. */
  actual?: string;
  /** Whether `--fix` could correct this automatically. */
  fixable: boolean;
  /** Citation to the rule or schema. */
  reference?: string;
  /** Suggested replacement value. */
  suggestedValue?: string;
}

export interface TaxParty {
  /** CNPJ or RUC depending on the country. */
  document: string;
  name: string;
  email?: string;
  phone?: string;
  address?: Address;
  /** Municipal tax registration (Brazil only). */
  municipalRegistration?: string;
  /** State tax registration (Brazil only). */
  stateRegistration?: string;
  /** Tax regime. Brazil only. */
  taxRegime?: string;
}

export interface Address {
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  /** BR: 8 digits. PE: 3 digits. */
  postalCode?: string;
  country?: string;
}

export interface TaxItem {
  /** Product code. */
  code?: string;
  description: string;
  quantity: number;
  /** Unit of measure: UND, HUR, KGM, etc. */
  unit: string;
  unitPrice: number;
  /** Total for this line, after discounts. */
  total: number;
  /** Discount applied to the line. */
  discount?: number;
  /** Line-level tax amount. */
  taxAmount: number;
  /** Country-specific tax code list. */
  taxCodes: TaxCode[];
  /** Item is a service (Brazil NFS-e) rather than a good. */
  isService?: boolean;
  /** Service code, where the jurisdiction requires one. */
  serviceCode?: string;
}

export interface TaxCode {
  /** Country-specific code: BR trib, PE sunat. */
  code: string;
  /** Rate as a percentage, e.g. 18 for 18%. */
  rate: number;
  /** Base amount the rate applies to. */
  base: number;
  /** Tax amount. */
  amount: number;
}

export interface PaymentTerm {
  /** Due date, ISO. */
  dueDate: string;
  amount: number;
  /** BR: dup, boleto, pix, card, cash. PE: cash, card, transfer. */
  method?: string;
  /** Instalment index, 1-based. */
  installment?: number;
}

export interface InvoiceDocument {
  /** Country. */
  country: CountryCode;
  /** Document type: BR nfe, nfs-e, cte; PE 01 factura, 07 nota de credito. */
  documentType: string;
  /** Unique per issuer per series and year. */
  number: string;
  /** Model or document type code. */
  model?: string;
  series: string;
  /** ISO date of issue. */
  issueDate: string;
  /** Currency, ISO 4217. */
  currency: string;
  issuer: TaxParty;
  recipient: TaxParty;
  items: TaxItem[];
  /** Untaxed total. */
  subtotal: number;
  /** Total discount. */
  discount?: number;
  /** Total tax. */
  taxTotal: number;
  /** Grand total. */
  total: number;
  payments: PaymentTerm[];
  /** Additional charges. */
  shipping?: number;
  /** BR only: service description for NFS-e. */
  serviceDescription?: string;
  /** Free-text notes. */
  notes?: string;
  /** Original document reference, for credit and debit notes. */
  references?: string[];
  /** Signature verification hash, where the country requires one. */
  signatureDigest?: string;
  /** Any field the country requires that this model does not name. */
  extensions?: Record<string, string>;
}

export interface ValidationResult {
  /** `true` only when there are no `error` issues. Warnings do not fail. */
  valid: boolean;
  /** 0-100. Starts at 100 and loses points per issue, weighted by severity. */
  score: number;
  issues: ValidationIssue[];
  /** Counts by severity. */
  counts: { error: number; warning: number; info: number };
  country: CountryCode;
  documentNumber: string;
  documentType: string;
  issuer: string;
  total: number;
  currency: string;
  validatedAt: string;
  /** Aggregate totals recomputed from the line items. */
  computed: { subtotal: number; taxTotal: number; total: number } | null;
}

export interface FixResult {
  /** The corrected document. Unchanged if nothing was fixable. */
  document: InvoiceDocument;
  /** Number of fields changed. */
  changes: number;
  /** What changed, for the audit trail. */
  applied: { path: string; from: string; to: string; ruleId: string }[];
  /** Issues that remain after fixing. */
  remaining: number;
}

/**
 * Parsed XML, shared between the parsers and the converters so that UBL and
 * NFS-e inputs go through one node shape rather than two.
 */
export interface XmlNode {
  name: string;
  /** Namespace prefix, when the tag was written as `ns:tag`. */
  prefix?: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Trimmed text content. */
  text: string;
  /** 1-based line where the tag opened, for error messages. */
  line: number;
}

export type ConversionDocument = XmlNode;

export interface ConversionResult {
  from: CountryCode;
  to: CountryCode;
  /** Target format: xml, json, csv, pdf-ready html. */
  format: 'xml' | 'json' | 'csv';
  output: string;
  /** Values that could not be mapped losslessly. */
  unmapped: { field: string; value: string; reason: string }[];
  warnings: string[];
}

/** Round to 2 decimal places, avoiding float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to 4 decimals: Brazilian and Peruvian tax rates need more precision. */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

export function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return round2(items.reduce((total, item) => total + pick(item), 0));
}
