import { describe, expect, it } from 'vitest';
import {
  validateInvoice,
  validateDocument,
  validateXml,
  fixInvoice,
  convertInvoice,
  detectCountry,
  formatResult,
  validateCnpj,
  validateCpf,
  formatCnpj,
  validateCep,
  SUPPORTED,
  type InvoiceDocument,
} from '../src/index.js';
import { parseBrazilXml } from '../src/countries/parse-brazil.js';
import { parseXml, find, text } from '../src/xml.js';
import { VALID_NFSE_XML, VALID_XML_WITH_ERRORS, VALID_UBL } from './fixtures.js';

/** A well-formed Brazilian NFS-e that should validate cleanly. */
function validInvoice(overrides: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    country: 'BR',
    documentType: 'nfs-e',
    number: '000000042',
    series: '1',
    issueDate: '2026-01-15',
    currency: 'BRL',
    issuer: {
      document: '11222333000181',
      name: 'Northwind Tecnologia Ltda',
      email: 'financeiro@northwind.example',
      municipalRegistration: '1234567',
      address: { city: 'Sao Paulo', state: 'SP', postalCode: '01310100', country: 'BR' },
    },
    recipient: {
      document: '98765432000198',
      name: 'Cliente Servicos SA',
      email: 'financeiro@cliente.example',
    },
    items: [
      {
        code: 'DEV-001',
        description: 'Desenvolvimento de software sob medida',
        quantity: 10,
        unit: 'HUR',
        unitPrice: 150,
        total: 1500,
        taxAmount: 30,
        taxCodes: [{ code: '0101', rate: 2, base: 1500, amount: 30 }],
        isService: true,
        serviceCode: '01.01',
      },
    ],
    subtotal: 1500,
    taxTotal: 30,
    total: 1530,
    payments: [{ dueDate: '2026-02-14', amount: 1530, method: 'boleto', installment: 1 }],
    serviceDescription: 'Desenvolvimento de sistema de gestao',
    ...overrides,
  };
}

describe('CNPJ and CPF check digits', () => {
  it('accepts valid CNPJs', () => {
    expect(validateCnpj('11.222.333/0001-81').valid).toBe(true);
    expect(validateCnpj('11222333000181').valid).toBe(true);
  });

  it('rejects a CNPJ with a wrong check digit', () => {
    const result = validateCnpj('11222333000182');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('check digit');
  });

  it('rejects a CNPJ of the wrong length', () => {
    expect(validateCnpj('112223330001').reason).toContain('14 digits');
  });

  it('rejects a repeated-digit CNPJ', () => {
    expect(validateCnpj('11111111111111').reason).toContain('same digit');
  });

  it('accepts a valid CPF', () => {
    expect(validateCpf('529.982.247-25').valid).toBe(true);
  });

  it('rejects an invalid CPF', () => {
    expect(validateCpf('52998224726').valid).toBe(false);
  });

  it('formats a CNPJ for display', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('validates CEP shape', () => {
    expect(validateCep('01310-100').valid).toBe(true);
    expect(validateCep('013101000').reason).toContain('8 digits');
    expect(validateCep('11111111').reason).toContain('same digit');
  });
});

describe('XML parsing', () => {
  it('parses elements, attributes and text', () => {
    const { root, issues } = parseXml('<a x="1"><b>hello</b><c/></a>');
    expect(issues).toHaveLength(0);
    expect(root?.name).toBe('a');
    expect(root?.attributes['x']).toBe('1');
    expect(find(root, 'b')?.text).toBe('hello');
    expect(root?.children).toHaveLength(2);
  });

  it('handles namespaces by prefix', () => {
    const { root } = parseXml('<ns:root xmlns:ns="urn:x"><ns:child>v</ns:child></ns:root>');
    expect(root?.name).toBe('root');
    expect(root?.prefix).toBe('ns');
    expect(text(root, 'child')).toBe('v');
  });

  it('handles comments, CDATA and declarations', () => {
    const { root, issues } = parseXml(
      '<?xml version="1.0"?><!-- a comment --><a><![CDATA[<not a tag>]]></a>',
    );
    expect(issues).toHaveLength(0);
    expect(find(root, 'a')).toBeUndefined();
    expect(root?.text).toContain('<not a tag>');
  });

  it('does not expand a DOCTYPE', () => {
    const { root, issues } = parseXml(
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>',
    );
    expect(issues.map((i) => i.ruleId)).toContain('XML/contains-doctype');
    expect(root?.text).not.toContain('/etc/passwd');
  });

  it('reports a mismatched closing tag', () => {
    const { issues } = parseXml('<a><b></c></a>');
    expect(issues.map((i) => i.ruleId)).toContain('XML/mismatched-tag');
  });

  it('reports an unclosed element', () => {
    const { issues } = parseXml('<a><b>text');
    expect(issues.map((i) => i.ruleId)).toContain('XML/unclosed-elements');
  });

  it('reports an empty document', () => {
    const { root, issues } = parseXml('not xml at all');
    expect(root).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
  });

  it('handles an attribute containing a > character', () => {
    const { root } = parseXml('<a note="a > b"><c/></a>');
    expect(root?.attributes['note']).toBe('a > b');
  });
});

describe('country detection', () => {
  it('detects Brazil from the root element', () => {
    const { root } = parseXml(VALID_NFSE_XML);
    expect(detectCountry(root!)).toBe('BR');
  });

  it('detects UBL as European', () => {
    const { root } = parseXml(VALID_UBL);
    expect(detectCountry(root!)).toBe('EU');
  });
});

describe('validating a Brazilian NFS-e', () => {
  it('accepts a correct document', () => {
    const result = validateInvoice(validInvoice());
    expect(result.valid, formatResult(result)).toBe(true);
    expect(result.counts.error).toBe(0);
    expect(result.country).toBe('BR');
  });

  it('recomputes the totals for the caller', () => {
    const result = validateInvoice(validInvoice());
    expect(result.computed).toEqual({ subtotal: 1500, taxTotal: 30, total: 1530 });
  });

  it('scoredoes not penalise a clean document', () => {
    expect(validateInvoice(validInvoice()).score).toBe(100);
  });

  it('reports a bad CNPJ', () => {
    const result = validateInvoice(validInvoice({ issuer: { document: '11222333000199', name: 'X' } }));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/identity/invalid-cnpj');
  });

  it('reports a subtotal that contradicts the line items', () => {
    const result = validateInvoice(validInvoice({ subtotal: 1400 }));
    const issue = result.issues.find((i) => i.ruleId === 'BR/calculation/subtotal-mismatch')!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('error');
    expect(issue.suggestedValue).toBe('1500.00');
    expect(result.valid).toBe(false);
  });

  it('reports a tax amount that does not match the rate', () => {
    const document = validInvoice();
    document.items[0]!.taxAmount = 33;
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/calculation/tax-total-mismatch');
  });

  it('reports a line total that does not match quantity x price', () => {
    const document = validInvoice();
    document.items[0]!.total = 1600;
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/calculation/line-total-mismatch');
  });

  it('reports a grand total that does not add up', () => {
    const result = validateInvoice(validInvoice({ total: 2000 }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/calculation/total-mismatch');
  });

  it('reports payment terms that do not sum to the total', () => {
    const result = validateInvoice(validInvoice({ payments: [{ dueDate: '2026-02-14', amount: 1000 }] }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/calculation/payment-total-mismatch');
  });

  it('reports an unknown tax code', () => {
    const document = validInvoice();
    document.items[0]!.taxCodes = [{ code: '99999', rate: 2, base: 1500, amount: 30 }];
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/tax/unknown-tax-code');
  });

  it('accepts a rate that differs from the catalogue default, as info', () => {
    const document = validInvoice();
    document.items[0]!.taxCodes = [{ code: '0101', rate: 3, base: 1500, amount: 45 }];
    document.items[0]!.taxAmount = 45;
    document.taxTotal = 45;
    document.total = 1545;
    document.payments = [{ dueDate: '2026-02-14', amount: 1545 }];
    const result = validateInvoice(document);
    const issue = result.issues.find((i) => i.ruleId === 'BR/tax/rate-differs-from-default')!;
    expect(issue.severity).toBe('info');
    expect(result.valid).toBe(true);
  });

  it('reports an out-of-range tax rate', () => {
    const document = validInvoice();
    document.items[0]!.taxCodes = [{ code: '0101', rate: 50, base: 1500, amount: 750 }];
    document.items[0]!.taxAmount = 750;
    document.taxTotal = 750;
    document.total = 2250;
    document.payments = [{ dueDate: '2026-02-14', amount: 2250 }];
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/tax/rate-out-of-range');
  });

  it('reports an invalid unit of measure', () => {
    const document = validInvoice();
    document.items[0]!.unit = 'FOOBAR';
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/format/invalid-uom');
  });

  it('reports a non-positive quantity', () => {
    const document = validInvoice();
    document.items[0]!.quantity = 0;
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/business/invalid-quantity');
  });

  it('reports a future issue date', () => {
    const result = validateInvoice(validInvoice({ issueDate: '2099-01-01' }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/date/future-issue-date');
  });

  it('reports a due date before the issue date', () => {
    const result = validateInvoice(validInvoice({ payments: [{ dueDate: '2026-01-01', amount: 1530 }] }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/date/due-before-issue');
  });

  it('reports a non-ISO date and offers a fix', () => {
    const result = validateInvoice(validInvoice({ issueDate: '15/01/2026' }));
    const issue = result.issues.find((i) => i.ruleId === 'BR/date/invalid-issue-date')!;
    expect(issue.suggestedValue).toBe('2026-01-15');
    expect(issue.fixable).toBe(true);
  });

  it('reports a non-BRL currency', () => {
    const result = validateInvoice(validInvoice({ currency: 'DOLLAR' }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/schema/invalid-currency');
  });

  it('reports a repeated invoice number within a batch', () => {
    const result = validateInvoice(validInvoice(), {
      seenNumbers: new Set(['11222333000181|1|000000042']),
    });
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/duplicate/repeated-number');
  });

  it('reports an already-issued invoice number', () => {
    const result = validateInvoice(validInvoice(), {
      issuedNumbers: new Set(['11222333000181|1|000000042']),
    });
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/duplicate/already-issued');
  });

  it('reports a line item with no description', () => {
    const document = validInvoice();
    document.items[0]!.description = '';
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/required/missing-item-description');
  });

  it('reports an invoice with no items', () => {
    const result = validateInvoice(validInvoice({ items: [] }));
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/required/no-items');
  });

  it('reports a discount larger than the line', () => {
    const document = validInvoice();
    document.items[0]!.discount = 5000;
    const result = validateInvoice(document);
    expect(result.issues.map((i) => i.ruleId)).toContain('BR/business/discount-exceeds-line');
  });

  it('sorts errors before warnings before info', () => {
    const result = validateInvoice(
      validInvoice({ currency: 'EUR', issueDate: '2099-01-01', number: 'ABC' }),
    );
    const severities = result.issues.map((i) => i.severity);
    const rank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]!]).toBeGreaterThanOrEqual(rank[severities[i - 1]!]);
    }
  });

  it('says so plainly when an unsupported country is validated', () => {
    const result = validateDocument({ ...validInvoice(), country: 'PE' });
    expect(result.valid).toBe(false);
    expect(formatResult(result)).toContain('Brazil');
  });
});

describe('validating raw XML', () => {
  it('parses and validates a national NFS-e', () => {
    const { document } = parseBrazilXml(VALID_NFSE_XML);
    expect(document?.number).toBe('000000042');
    expect(document?.issuer.name).toContain('Northwind');
    expect(document?.items.length).toBeGreaterThan(0);
  });

  it('validates the parsed document', () => {
    const result = validateXml(VALID_NFSE_XML);
    expect(result.country).toBe('BR');
    expect(result.documentNumber).toBe('000000042');
  });

  it('reports the errors in a fixture with errors', () => {
    const result = validateXml(VALID_XML_WITH_ERRORS);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports an unrecognised root element', () => {
    const result = validateXml('<Something><a/></Something>');
    expect(result.valid).toBe(false);
  });

  it('returns a result for garbage rather than throwing', () => {
    expect(() => validateXml('}{ nonsense <<<')).not.toThrow();
    expect(validateXml('}{ nonsense <<<').valid).toBe(false);
  });

  it('rejects a foreign document rather than pretending to validate it', () => {
    const result = validateXml(VALID_UBL);
    expect(result.valid).toBe(false);
    expect(formatResult(result)).toContain('not implemented');
  });
});

describe('--fix', () => {
  it('corrects the arithmetic without changing the intent', () => {
    const result = fixInvoice(validInvoice({ subtotal: 1400, taxTotal: 0, total: 1400 }));
    expect(result.changes).toBeGreaterThan(0);
    expect(result.document.subtotal).toBe(1500);
    expect(result.document.taxTotal).toBe(30);
    expect(result.document.total).toBe(1530);
    expect(result.remaining).toBe(0);
  });

  it('records every change for the audit trail', () => {
    const result = fixInvoice(validInvoice({ subtotal: 1400 }));
    expect(result.applied.length).toBeGreaterThan(0);
    for (const change of result.applied) {
      expect(change.path).toBeTruthy();
      expect(change.ruleId).toBeTruthy();
      expect(change).toHaveProperty('from');
      expect(change).toHaveProperty('to');
    }
  });

  it('does not change a correct document', () => {
    const result = fixInvoice(validInvoice());
    expect(result.changes).toBe(0);
  });

  it('normalises a Brazilian date to ISO', () => {
    const result = fixInvoice(validInvoice({ issueDate: '15/01/2026' }));
    expect(result.document.issueDate).toBe('2026-01-15');
  });

  it('normalises a non-ISO currency to BRL', () => {
    const result = fixInvoice(validInvoice({ currency: 'REAL' }));
    expect(result.document.currency).toBe('BRL');
  });

  it('repairs a due date before the issue date', () => {
    const result = fixInvoice(validInvoice({ payments: [{ dueDate: '2026-01-01', amount: 1530 }] }));
    expect(result.document.payments[0]!.dueDate).toBe('2026-01-15');
  });

  it('does not invent a tax rate or a document number', () => {
    const document = validInvoice();
    document.items[0]!.taxCodes = [{ code: '0101', rate: 2, base: 0, amount: 0 }];
    document.items[0]!.taxAmount = 0;
    const result = fixInvoice(document);
    // The zero base is repaired from the line value; the rate is untouched.
    expect(result.document.items[0]!.taxCodes[0]!.rate).toBe(2);
    expect(result.document.items[0]!.taxCodes[0]!.base).toBe(1500);
  });

  it('leaves an unsupported country untouched', () => {
    const document = { ...validInvoice(), country: 'PE' as const };
    const result = fixInvoice(document);
    expect(result.changes).toBe(0);
  });
});

describe('conversion', () => {
  it('produces NFS-e XML from a document', () => {
    const result = convertInvoice(validInvoice(), 'xml');
    expect(result.format).toBe('xml');
    expect(result.output).toContain('<NFS-e');
    expect(result.output).toContain('<numeroNFSe>000000042</numeroNFSe>');
    expect(result.output).toContain('<codigoTributacao>0101</codigoTributacao>');
  });

  it('warns that a signature digest is missing', () => {
    const result = convertInvoice(validInvoice(), 'xml');
    expect(result.warnings.join(' ')).toContain('signature');
  });

  it('parses UBL into the document model', () => {
    const result = convertInvoice(VALID_UBL, 'json');
    const parsed = JSON.parse(result.output);
    expect(parsed.number).toBe('INV-2026-001');
    expect(parsed.issuer.name).toBe('Acme Supplies Ltd');
    expect(parsed.items.length).toBe(1);
    expect(result.unmapped.length).toBeGreaterThan(0);
  });

  it('reports UBL classifications that are not ISS codes', () => {
    const result = convertInvoice(VALID_UBL, 'json');
    expect(result.unmapped.map((u) => u.field)).toContain('items[0].taxCodes');
  });

  it('produces CSV with one row per tax code', () => {
    const result = convertInvoice(validInvoice(), 'csv');
    const rows = result.output.split('\n');
    expect(rows[0]).toContain('invoice_number');
    expect(rows[1]).toContain('000000042');
  });

  it('escapes CSV cells containing a comma', () => {
    const result = convertInvoice(validInvoice({ items: [{ ...validInvoice().items[0]!, description: 'A, B; C' }] }), 'csv');
    expect(result.output).toContain('"A, B; C"');
  });

  it('round-trips a document through JSON', () => {
    const result = convertInvoice(validInvoice(), 'json');
    const parsed = JSON.parse(result.output);
    expect(parsed.number).toBe('000000042');
    expect(parsed.items[0].taxCodes[0].rate).toBe(2);
  });
});

describe('support metadata', () => {
  it('declares Brazil with its mandate', () => {
    expect(SUPPORTED.map((s) => s.country)).toContain('BR');
    expect(SUPPORTED[0]!.mandate).toContain('2026');
  });
});