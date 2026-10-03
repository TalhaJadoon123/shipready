import type { ConversionResult, ConversionDocument, InvoiceDocument } from './types.js';
import { round2 } from './types.js';

/**
 * Format conversion.
 *
 * Three conversions, chosen because they are the three that actually come up:
 *
 *  - **UBL** -> our document model, for suppliers who only speak UBL;
 *  - our model -> **NFS-e XML**, for issuing;
 *  - our model -> **CSV**, for the spreadsheet an accountant sends back.
 *
 * Every conversion reports what it could not map. A silent drop of, say, a
 * municipal tax registration produces an invoice that is wrong in a way nobody
 * notices until it is rejected at the tax authority.
 */

// ---------------------------------------------------------------------------
// UBL
// ---------------------------------------------------------------------------

/** Map a UBL 2.1 invoice into our model. */
export function fromUbl(parsed: { root: ConversionDocument | null }): ConversionResult {
  const unmapped: ConversionResult['unmapped'] = [];
  const warnings: string[] = [];

  // The root of a UBL invoice *is* the Invoice element, so accept it directly
  // as well as looking one level down.
  const root = parsed.root ?? undefined;
  const invoice =
    root === undefined
      ? undefined
      : root.name === 'Invoice'
        ? root
        : findNode(root, 'Invoice');
  if (!invoice) {
    warnings.push('No UBL Invoice element found.');
    return {
      from: 'EU',
      to: 'EU',
      format: 'json',
      output: JSON.stringify(parsed, null, 2),
      unmapped,
      warnings,
    };
  }

  const supplier = findNode(invoice, 'AccountingSupplierParty');
  const customer = findNode(invoice, 'AccountingCustomerParty');
  // UBL nests the identifying details under a bare <Party>, so every party path
// has to descend through it.
const supplierTaxScheme = findNode(supplier, 'Party', 'PartyTaxScheme', 'CompanyID');
const customerTaxScheme = findNode(customer, 'Party', 'PartyTaxScheme', 'CompanyID');

  const items = collectNodes(invoice, 'InvoiceLine').map((line, index) => {
    const quantity = parseNumber(textOf(findNode(line, 'InvoicedQuantity')) ?? '1');
    const price = parseNumber(textOf(findNode(line, 'PriceAmount')) ?? '0');
    const total = parseNumber(
      textOf(findNode(line, 'LineExtensionAmount')) ?? String(quantity * price),
    );
    const category = findNode(line, 'Item', 'ClassificationCode')?.attributes?.listID;
    if (!category) {
      unmapped.push({
        field: `items[${index}].taxCodes`,
        value: textOf(findNode(line, 'Name')) ?? 'unnamed item',
        reason: 'UBL carries an UN/ECE 5305 classification, not an ISS or SUNAT tax code',
      });
    }
    return {
      code: textOf(findNode(line, 'ID')) ?? undefined,
      description: textOf(findNode(line, 'Name')) ?? '',
      quantity,
      unit: findNode(line, 'InvoicedQuantity')?.attributes?.unitCode ?? 'UND',
      unitPrice: price,
      total,
      discount: 0,
      taxAmount: round2(parseNumber(textOf(findNode(line, 'TaxAmount')) ?? '0')),
      taxCodes: category ? [{ code: category, rate: 0, base: total, amount: 0 }] : [],
    };
  });

  const taxTotalNode = findNode(invoice, 'TaxTotal', 'TaxAmount');
  const taxTotal = parseNumber(textOf(taxTotalNode) ?? '0');
  const grandTotal = parseNumber(
    textOf(findNode(invoice, 'LegalMonetaryTotal', 'PayableAmount')) ?? '0',
  );

  const result: InvoiceDocument = {
    country: 'EU',
    documentType: '380',
    series: '',
    number: textOf(findNode(invoice, 'ID')) ?? '',
    issueDate: textOf(findNode(invoice, 'IssueDate')) ?? '',
    currency: textOf(findNode(invoice, 'DocumentCurrencyCode')) ?? 'EUR',
    issuer: {
      document: textOf(supplierTaxScheme) ?? '',
      name: textOf(findNode(supplier, 'Party', 'PartyLegalEntity', 'RegistrationName')) ?? '',
      email: textOf(findNode(supplier, 'Party', 'ElectronicMail')),
      phone: textOf(findNode(supplier, 'Party', 'Telephone')),
      address: parseUblAddress(findNode(supplier, 'Party', 'PostalAddress')),
    },
    recipient: {
      document: textOf(customerTaxScheme) ?? '',
      name: textOf(findNode(customer, 'Party', 'PartyLegalEntity', 'RegistrationName')) ?? '',
      address: parseUblAddress(findNode(customer, 'Party', 'PostalAddress')),
    },
    items,
    subtotal: round2(items.reduce((s, i) => s + i.total - (i.discount ?? 0), 0)),
    taxTotal,
    total: grandTotal,
    payments:
      collectNodes(findNode(invoice, 'PaymentMeans') ?? undefined, 'PaymentMandate').length > 0
        ? [
            {
              dueDate:
                textOf(findNode(invoice, 'PaymentMeans', 'PaymentDueDate')) ??
                textOf(findNode(invoice, 'PaymentMeans', 'PaymentMandate', 'PaymentDueDate')) ??
                textOf(findNode(invoice, 'IssueDate')) ??
                '',
              amount: grandTotal,
              method: textOf(findNode(invoice, 'PaymentMeans', 'PaymentMeansCode')) ?? undefined,
            },
          ]
        : grandTotal
          ? [{ dueDate: textOf(findNode(invoice, 'IssueDate')) ?? '', amount: grandTotal }]
          : [],
    ...(textOf(findNode(invoice, 'Note')) ? { notes: textOf(findNode(invoice, 'Note'))! } : {}),
  };

  if (grandTotal !== round2(result.subtotal + taxTotal)) {
    warnings.push(
      `UBL payable amount (${grandTotal}) does not equal line total plus tax (${round2(result.subtotal + taxTotal)}). The document total was kept as stated; the validator will report the discrepancy.`,
    );
  }

  return {
    from: 'EU',
    to: 'EU',
    format: 'json',
    output: JSON.stringify(result, null, 2),
    unmapped,
    warnings,
  };
}

function parseUblAddress(node: ConversionNode | undefined) {
  if (!node) return undefined;
  return {
    street: textOf(findNode(node, 'StreetName')),
    number: textOf(findNode(node, 'BuildingNumber')),
    district: textOf(findNode(node, 'CitySubdivisionName')),
    city: textOf(findNode(node, 'CityName')),
    postalCode: textOf(findNode(node, 'PostalZone')),
    country: textOf(findNode(node, 'Country', 'IdentificationCode')),
  };
}

// ---------------------------------------------------------------------------
// NFS-e XML output
// ---------------------------------------------------------------------------

/** Render an NFS-e in the national standard layout (ADN 15/2023). */
export function toNfseXml(document: InvoiceDocument): ConversionResult {
  const unmapped: ConversionResult['unmapped'] = [];
  const warnings: string[] = [];

  if (document.country !== 'BR') {
    unmapped.push({
      field: 'country',
      value: document.country,
      reason:
        'NFS-e is a Brazilian document; foreign tax registrations and ISS codes are not applicable',
    });
  }

  const esc = (value: string | number | undefined): string =>
    escapeXml(value === undefined || value === null ? '' : String(value));

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">');
  lines.push('  <infNFS-e Id="NFS' + esc(document.number) + '">');
  lines.push('    <ide>');
  lines.push(`      <numeroNFSe>${esc(document.number)}</numeroNFSe>`);
  lines.push(`      <serie>${esc(document.series)}</serie>`);
  lines.push(`      <dataEmissao>${esc(document.issueDate)}</dataEmissao>`);
  lines.push('    </ide>');
  lines.push('    <emitente>');
  lines.push(`      <cpfCnpj>${esc(document.issuer.document)}</cpfCnpj>`);
  lines.push(`      <razaoSocial>${esc(document.issuer.name)}</razaoSocial>`);
  if (document.issuer.municipalRegistration) {
    lines.push(
      `      <inscricaoMunicipal>${esc(document.issuer.municipalRegistration)}</inscricaoMunicipal>`,
    );
  }
  if (document.issuer.address?.city) {
    lines.push('      <endereco>');
    lines.push(`        <municipio>${esc(document.issuer.address.city)}</municipio>`);
    lines.push(`        <uf>${esc(document.issuer.address.state)}</uf>`);
    if (document.issuer.address.postalCode) {
      lines.push(`        <cep>${esc(document.issuer.address.postalCode)}</cep>`);
    }
    lines.push('      </endereco>');
  }
  lines.push('    </emitente>');
  lines.push('    <destinatario>');
  lines.push(`      <cpfCnpj>${esc(document.recipient.document)}</cpfCnpj>`);
  lines.push(`      <razaoSocial>${esc(document.recipient.name)}</razaoSocial>`);
  lines.push('    </destinatario>');
  lines.push('    <servicos>');

  document.items.forEach((item) => {
    lines.push('      <servico>');
    if (item.serviceCode)
      lines.push(`        <codigoServico>${esc(item.serviceCode)}</codigoServico>`);
    lines.push(`        <discriminacao>${esc(item.description)}</discriminacao>`);
    lines.push('        <valores>');
    lines.push(`          <quantidade>${esc(item.quantity)}</quantidade>`);
    lines.push(`          <valorUnitario>${esc(item.unitPrice.toFixed(2))}</valorUnitario>`);
    lines.push(`          <valorServicos>${esc(item.total.toFixed(2))}</valorServicos>`);
    lines.push(`          <valorDeducoes>${esc((item.discount ?? 0).toFixed(2))}</valorDeducoes>`);
    lines.push(`          <valorIss>${esc(item.taxAmount.toFixed(2))}</valorIss>`);
    lines.push(`          <moeda>${esc(document.currency)}</moeda>`);
    lines.push('        </valores>');
    if (item.taxCodes.length > 0) {
      lines.push('        <tributos>');
      for (const tax of item.taxCodes) {
        lines.push('          <tributo>');
        lines.push(`            <codigoTributacao>${esc(tax.code)}</codigoTributacao>`);
        lines.push(`            <aliquota>${esc(tax.rate)}</aliquota>`);
        lines.push('          </tributo>');
      }
      lines.push('        </tributos>');
    }
    lines.push('      </servico>');
  });

  lines.push('    </servicos>');
  lines.push('    <totServicos>');
  lines.push(`      <valorServicos>${esc(document.subtotal.toFixed(2))}</valorServicos>`);
  lines.push(`      <valorIss>${esc(document.taxTotal.toFixed(2))}</valorIss>`);
  lines.push(`      <valorTotal>${esc(document.total.toFixed(2))}</valorTotal>`);
  lines.push('    </totServicos>');
  if (document.serviceDescription) {
    lines.push(`    <servicoPrestado>${esc(document.serviceDescription)}</servicoPrestado>`);
  }
  for (const payment of document.payments) {
    lines.push('    <pagamento>');
    lines.push(`      <formaPagamento>${esc(payment.method ?? '01')}</formaPagamento>`);
    lines.push(`      <dataPagamento>${esc(payment.dueDate)}</dataPagamento>`);
    lines.push(`      <valorPagamento>${esc(payment.amount.toFixed(2))}</valorPagamento>`);
    lines.push('    </pagamento>');
  }
  lines.push('  </infNFS-e>');
  lines.push('</NFS-e>');

  if (!document.signatureDigest) {
    warnings.push(
      'No signature digest. Brazilian municipal NFS-e almost always requires a digital signature (XMLDSig) issued by an authorised certificate provider; add it before submitting.',
    );
  }
  for (const reference of document.references ?? []) {
    if (!reference) continue;
    unmapped.push({
      field: 'references',
      value: reference,
      reason: 'Reference documents are not carried in this output layout',
    });
  }

  return {
    from: document.country,
    to: 'BR',
    format: 'xml',
    output: lines.join('\n'),
    unmapped,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Render line items as CSV, the format an accountant can actually use. */
export function toCsv(document: InvoiceDocument): ConversionResult {
  const headers = [
    'invoice_number',
    'series',
    'issue_date',
    'issuer_document',
    'issuer_name',
    'recipient_document',
    'recipient_name',
    'item_code',
    'item_description',
    'quantity',
    'unit',
    'unit_price',
    'discount',
    'line_total',
    'tax_code',
    'tax_rate',
    'tax_base',
    'tax_amount',
    'line_tax_total',
    'currency',
    'invoice_subtotal',
    'invoice_tax_total',
    'invoice_total',
  ];

  const rows: string[] = [headers.join(',')];
  for (const item of document.items) {
    for (const tax of item.taxCodes.length > 0
      ? item.taxCodes
      : [{ code: '', rate: 0, base: item.total, amount: 0 }]) {
      rows.push(
        [
          document.number,
          document.series,
          document.issueDate,
          document.issuer.document,
          document.issuer.name,
          document.recipient.document,
          document.recipient.name,
          item.code ?? '',
          item.description,
          String(item.quantity),
          item.unit,
          item.unitPrice.toFixed(2),
          (item.discount ?? 0).toFixed(2),
          item.total.toFixed(2),
          tax.code,
          String(tax.rate),
          tax.base.toFixed(2),
          tax.amount.toFixed(2),
          item.taxAmount.toFixed(2),
          document.currency,
          document.subtotal.toFixed(2),
          document.taxTotal.toFixed(2),
          document.total.toFixed(2),
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }

  return {
    from: document.country,
    to: document.country,
    format: 'csv',
    output: rows.join('\n'),
    unmapped:
      document.payments.length > 0
        ? [
            {
              field: 'payments',
              value: document.payments.length + ' term(s)',
              reason: 'CSV output carries line items; payment terms are in the invoice total',
            },
          ]
        : [],
    warnings:
      document.items.length === 0
        ? ['Document has no line items; the CSV will contain only a header.']
        : [],
  };
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// UBL node helpers. Operate on the same node shape the XML parser produces.
// ---------------------------------------------------------------------------

interface ConversionNode {
  name: string;
  attributes: Record<string, string>;
  children: ConversionNode[];
  text: string;
}

function findNode(node: ConversionNode | undefined, ...path: string[]): ConversionNode | undefined {
  let current = node;
  for (const name of path) {
    if (!current) return undefined;
    current = current.children.find((c) => c.name === name);
  }
  return current;
}

function collectNodes(node: ConversionNode | undefined, name: string): ConversionNode[] {
  const out: ConversionNode[] = [];
  const walk = (n: ConversionNode): void => {
    for (const child of n.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  if (node) walk(node);
  return out;
}

function textOf(node: ConversionNode | undefined): string | undefined {
  const value = node?.text.trim();
  return value ? value : undefined;
}

function parseNumber(value: string): number {
  const n = Number.parseFloat(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
