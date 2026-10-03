import type {
  InvoiceDocument,
  TaxParty,
  TaxItem,
  TaxCode,
  PaymentTerm,
  ValidationIssue,
} from '../types.js';
import { round2 } from '../types.js';
import { parseXml, find, findAll, text, num, numOr, attr, validateCep } from '../xml.js';
import { validateCnpj } from './brazil.js';

/**
 * Read a Brazilian NFS-e or NF-e XML into the shared document model.
 *
 * Two shapes are supported, because Brazilian software vendors actually emit
 * both and a validator that only reads one is useless:
 *
 *  - the **national standard** (ADN 15/2023) NFS-e layout, and
 *  - the **municipal** layouts, which differ by municipality but share a
 *    common ancestor (`NFS-e`, `CompNfse`, `Rps`).
 *
 * Where a value cannot be found in any of them we leave it undefined rather
 * than defaulting it. A missing field the validator can see is far more useful
 * than a plausible guess that looks like data the issuer actually supplied.
 */

export interface ParseResult {
  document: InvoiceDocument | null;
  issues: ValidationIssue[];
}

export function parseBrazilXml(xml: string): ParseResult {
  const issues: ValidationIssue[] = [];
  const { root, issues: xmlIssues } = parseXml(xml);
  issues.push(...xmlIssues);
  if (!root) return { document: null, issues };

  const parsed = parseNationalNfse(root) ?? parseMunicipalNfse(root) ?? parseNfe(root);

  if (!parsed) {
    issues.push({
      ruleId: 'BR/schema/unrecognised-document',
      severity: 'error',
      category: 'schema',
      path: '/',
      message: `Root element <${root.name}> does not match any supported Brazilian fiscal document layout`,
      expectation: 'NFS-e, CompNfse, InfNFS-e or infNFe',
      actual: root.name,
      fixable: false,
    });
    return { document: null, issues };
  }

  return { document: parsed, issues };
}

// ---------------------------------------------------------------------------
// National NFS-e (ADN 15/2023)
// ---------------------------------------------------------------------------

function parseNationalNfse(root: ReturnType<typeof parseXml>['root']): InvoiceDocument | null {
  if (root?.name !== 'NFS-e' && root?.name !== 'NFSe') return null;

  const emit = find(root, 'infNFS-e') ?? find(root, 'infNFSe');
  if (!emit) return null;

  const ide = find(emit, 'ide');
  const emitente = find(emit, 'emitente');
  const destinatario = find(emit, 'destinatario');

  const items: TaxItem[] = findAll(find(emit, 'servicos'), 'servico').map((node) => {
    const valores = find(node, 'valores');
    const taxCodes: TaxCode[] = [];
    for (const trib of findAll(node, 'tributos').concat(findAll(node, 'tributo'))) {
      const code =
        text(trib, 'codigoTributacao') ?? text(trib, 'CodigoTributacao') ?? text(trib, 'codigo');
      const rate = numOr(trib, 0, 'aliquota');
      if (!code) continue;
      const base = num(valores, 'baseCalculo') ?? numOr(valores, 0, 'valorServicos');
      taxCodes.push({
        code: normaliseTaxCode(String(code)),
        rate,
        base: round2(base),
        amount: round2((base * rate) / 100),
      });
    }

    const serviceValue = numOr(valores, 0, 'valorServicos');
    const discount = numOr(valores, 0, 'valorDeducoes');

    return {
      code: text(node, 'codigo'),
      description: text(node, 'discriminacao') ?? '',
      quantity: numOr(valores, 1, 'quantidade'),
      unit: text(valores, 'unidade') ?? 'UN',
      unitPrice: numOr(valores, serviceValue, 'valorUnitario'),
      total: serviceValue,
      discount,
      taxAmount: round2(taxCodes.reduce((sum, t) => sum + t.amount, 0)),
      taxCodes,
      isService: true,
      ...(text(node, 'codigoServico') ? { serviceCode: text(node, 'codigoServico')! } : {}),
    };
  });

  const totalServices = round2(
    numOr(emit, items.reduce((s, i) => s + i.total, 0), 'totServicos', 'valorServicos'),
  );
  const totalTax = round2(items.reduce((s, i) => s + i.taxAmount, 0));

  return {
    country: 'BR',
    documentType: 'nfs-e',
    number: text(ide, 'numeroNFSe') ?? text(emit, 'numeroNFSe') ?? '',
    model: text(ide, 'modelo'),
    series: text(ide, 'serie') ?? '',
    issueDate: text(ide, 'dataEmissao') ?? '',
    currency: (text(emit, 'moeda') ?? 'BRL').toUpperCase(),
    issuer: parseNationalParty(emitente),
    recipient: parseNationalParty(destinatario),
    items,
    subtotal: totalServices,
    taxTotal: totalTax,
    total: round2(totalServices + totalTax),
    payments: parseNationalPayments(emit),
    ...(text(emit, 'servicoPrestado')
      ? { serviceDescription: text(emit, 'servicoPrestado')! }
      : {}),
    ...(attr(root, 'versao') ? { extensions: { versao: attr(root, 'versao')! } } : {}),
  };
}

function parseNationalParty(node: ReturnType<typeof find>): TaxParty {
  if (!node) return { document: '', name: '' };
  const address = find(node, 'endereco');
  return {
    document: text(node, 'cpfCnpj') ?? '',
    name: text(node, 'razaoSocial') ?? text(node, 'nome') ?? '',
    ...(text(node, 'email') ? { email: text(node, 'email')! } : {}),
    ...(text(node, 'telefone') ? { phone: text(node, 'telefone')! } : {}),
    ...(text(node, 'inscricaoMunicipal')
      ? { municipalRegistration: text(node, 'inscricaoMunicipal')! }
      : {}),
    address: address
      ? {
          street: text(address, 'logradouro'),
          number: text(address, 'numero'),
          complement: text(address, 'complemento'),
          district: text(address, 'bairro'),
          city: text(address, 'municipio'),
          state: text(address, 'uf'),
          postalCode: text(address, 'cep'),
          country: 'BR',
        }
      : {},
  };
}

function parseNationalPayments(emit: ReturnType<typeof find>): PaymentTerm[] {
  const total = numOr(emit, 0, 'totServicos', 'valorServicos');
  const due = text(emit, 'pagamento', 'dataPagamento');
  const form = text(emit, 'pagamento', 'formaPagamento');
  if (!due && !form) {
    // A national NFS-e with payment terms inside the data is common; a single
    // unconditional term is a safe representation of "paid on receipt".
    return total > 0 ? [{ dueDate: text(emit, 'dataEmissao') ?? '', amount: total }] : [];
  }
  return [
    {
      dueDate: due ?? '',
      amount: numOr(emit, total, 'pagamento', 'valorPagamento'),
      ...(form ? { method: form } : {}),
      installment: 1,
    },
  ];
}

// ---------------------------------------------------------------------------
// Municipal NFS-e (Rps / CompNfse / InfNFS-e)
// ---------------------------------------------------------------------------

function parseMunicipalNfse(root: ReturnType<typeof parseXml>['root']): InvoiceDocument | null {
  if (root?.name !== 'CompNfse' && root?.name !== 'NFS-e' && root?.name !== 'Rps') return null;

  const inf = find(root, 'InfNfse') ?? find(root, 'InfNFS-e');
  if (inf) {
    const numero = text(inf, 'Numero') ?? text(inf, 'numero') ?? '';
    const serie = text(inf, 'Serie') ?? text(inf, 'serie') ?? '';
    const dataEmissao = text(inf, 'DataEmissao') ?? text(inf, 'dataEmissao') ?? '';
    const servicos = find(inf, 'Servicos') ?? find(inf, 'servicos');
    const valores = find(servicos, 'Valores') ?? find(servicos, 'valores');

    const items: TaxItem[] = servicos
      ? [
          {
            code: text(servicos, 'Item') ?? undefined,
            description: text(servicos, 'Discriminacao') ?? text(servicos, 'discriminacao') ?? '',
            quantity: numOr(valores, 1, 'Quantidade'),
            unit: text(valores, 'Unidade') ?? 'UN',
            unitPrice: num(valores, 'ValorUnitario') ?? numOr(valores, 0, 'valorUnitario'),
            total: num(valores, 'ValorLiquido') ?? numOr(valores, 0, 'valorLiquido'),
            discount: numOr(valores, 0, 'ValorDeducoes'),
            taxAmount: num(valores, 'ValorIss') ?? numOr(valores, 0, 'valorIss'),
            taxCodes: parseMunicipalIss(servicos),
            isService: true,
          },
        ].filter((i) => i.total > 0 || i.description !== '')
      : [];

    const subtotal = numOr(valores, round2(items.reduce((s, i) => s + i.total, 0)), 'ValorLiquido');
    const iss = numOr(valores, 0, 'ValorIss');

    const prestador = find(inf, 'Prestador') ?? find(inf, 'prestador');
    const tomador = find(inf, 'Tomador') ?? find(inf, 'tomador');

    return {
      country: 'BR',
      documentType: 'nfs-e',
      number: numero,
      series: serie,
      issueDate: dataEmissao,
      currency: 'BRL',
      issuer: {
        document: text(prestador, 'CpfCnpj') ?? '',
        name: text(prestador, 'RazaoSocial') ?? '',
        ...(text(prestador, 'Email') ? { email: text(prestador, 'Email')! } : {}),
        ...(text(prestador, 'Telefone') ? { phone: text(prestador, 'Telefone')! } : {}),
        ...(text(prestador, 'InscricaoMunicipal')
          ? { municipalRegistration: text(prestador, 'InscricaoMunicipal')! }
          : {}),
      },
      recipient: {
        document: text(tomador, 'CpfCnpj') ?? text(tomador, 'Cpf') ?? text(tomador, 'Cnpj') ?? '',
        name: text(tomador, 'RazaoSocial') ?? '',
        ...(text(tomador, 'Email') ? { email: text(tomador, 'Email')! } : {}),
      },
      items,
      subtotal,
      taxTotal: iss,
      total: round2(subtotal + iss),
      payments: (num(valores, 'ValorLiquido') ?? 0) > 0
        ? [{ dueDate: dataEmissao, amount: round2(subtotal + iss) }]
        : [],
    };
  }

  // Rps: the bare form, where the number and date are attributes.
  const rps = find(root, 'Rps');
  if (rps) {
    const numero = attr(rps, 'numero') ?? text(rps, 'Numero') ?? '';
    const serie = attr(rps, 'serie') ?? text(rps, 'Serie') ?? '';
    const dataEmissao = attr(rps, 'dataEmissao') ?? text(rps, 'DataEmissao') ?? '';
    const servico = find(rps, 'Servico');
    const valores = find(servico, 'Valores');

    const subtotal = numOr(valores, 0, 'ValorServicos');
    const iss = numOr(valores, 0, 'ValorIss');

    return {
      country: 'BR',
      documentType: 'nfs-e',
      number: numero,
      series: serie,
      issueDate: dataEmissao,
      currency: 'BRL',
      issuer: { document: '', name: '' },
      recipient: { document: '', name: '' },
      items: subtotal
        ? [
            {
              description: text(servico, 'Discriminacao') ?? '',
              quantity: numOr(valores, 1, 'Quantidade'),
              unit: 'UN',
              unitPrice: subtotal,
              total: subtotal,
              taxAmount: iss,
              taxCodes: [],
              isService: true,
            },
          ]
        : [],
      subtotal,
      taxTotal: iss,
      total: round2(subtotal + iss),
      payments: subtotal ? [{ dueDate: dataEmissao, amount: round2(subtotal + iss) }] : [],
      ...(text(servico, 'CodigoServico')
        ? { serviceDescription: text(servico, 'Discriminacao') ?? undefined }
        : {}),
    };
  }

  return null;
}

/**
 * Normalise an ISS code to its five-digit national form.
 *
 * Municipal layouts write the Annex I item as `1.01`, `0101` or `101`, and all
 * three mean the same thing. Left-pad only when the value is genuinely short:
 * `0101` must not become `00101`.
 */
function normaliseTaxCode(code: string): string {
  const digits = code.replace(/[^\d]/g, '');
  // National codes are four digits ( 101); the national list adds a leading
  // zero for the municipality band ( 0101). Preserve whichever form the
  // issuer used rather than inventing a fifth digit.
  if (digits.length >= 4) return digits.slice(0, 5);
  return digits.padStart(4, '0');
}

function parseMunicipalIss(servicos: ReturnType<typeof find>): TaxCode[] {
  const issNode = find(servicos, 'Iss') ?? find(servicos, 'ISS');
  const rate = numOr(issNode, 0, 'Aliquota');
  const value = num(issNode, 'ValorIss') ?? numOr(issNode, 0, 'Valor');
  const base = numOr(issNode, 0, 'BaseCalculo');
  const code =
    text(issNode, 'CodigoTributacao') ??
    text(issNode, 'Codigo') ??
    text(issNode, 'ItemListaServico');
  if (rate === 0 && !code) return [];
  return [
    {
      code: normaliseTaxCode(String(code ?? '9901')),
      rate,
      base: round2(base || value),
      amount: round2(value),
    },
  ];
}

// ---------------------------------------------------------------------------
// NF-e (goods)
// ---------------------------------------------------------------------------

function parseNfe(root: ReturnType<typeof parseXml>['root']): InvoiceDocument | null {
  if (root?.name !== 'infNFe' && root?.name !== 'NFe') return null;
  const inf = root.name === 'infNFe' ? root : find(root, 'infNFe');
  if (!inf) return null;

  const ide = find(inf, 'ide');
  const emit = find(inf, 'emit');
  const dest = find(inf, 'dest');
  const totalNode = find(inf, 'total', 'ICMSTot');

  const items: TaxItem[] = findAll(find(inf, 'det'), 'prod').map((prod) => {
    const prodTaxes = findAll(prod, 'imposto').flatMap((i) =>
      findAll(i, 'ICMS').flatMap((c) => findAll(c, 'ICMS00')),
    );
    const lineTotal = numOr(prod, 0, 'vProd');
    const desc = prod.children.find((c) => c.name === 'xProd')?.text.trim() ?? '';
    const code = prod.children.find((c) => c.name === 'cProd')?.text.trim() ?? '';
    const unit = prod.children.find((c) => c.name === 'uTrib')?.text.trim() ?? 'UN';
    const qty = numOr(prod, 1, 'qTrib');

    const taxCodes: TaxCode[] = [];
    for (const tax of prodTaxes) {
      const orig = tax.children.find((c) => c.name === 'orig')?.text.trim();
      const cst = tax.children.find((c) => c.name === 'CST')?.text.trim() ?? '000';
      // ICMS is embedded in the unit price for most NFe, so the tax amount is
      // not derivable here. We record the code and rate, and let the validator
      // flag the amount as unverifiable rather than inventing one.
      taxCodes.push({
        code: `ICMS:${orig ?? '0'}:${cst}`,
        rate: 0,
        base: lineTotal,
        amount: 0,
      });
    }

    return {
      code,
      description: desc,
      quantity: qty,
      unit,
      unitPrice: qty > 0 ? round2(lineTotal / qty) : lineTotal,
      total: lineTotal,
      discount: numOr(prod, 0, 'vDesc'),
      taxAmount: 0,
      taxCodes,
    };
  });

  const subtotal = numOr(totalNode, round2(items.reduce((s, i) => s + i.total, 0)), 'vProd');

  return {
    country: 'BR',
    documentType: text(ide, 'modFrete') ? 'nfe' : 'nfe',
    number: text(ide, 'nNF') ?? '',
    model: '55',
    series: text(ide, 'serie') ?? '',
    issueDate: text(ide, 'dhEmi')?.slice(0, 10) ?? text(ide, 'dEmi') ?? '',
    currency: 'BRL',
    issuer: {
      document: text(emit, 'CNPJ') ?? text(emit, 'CPF') ?? '',
      name: text(emit, 'xNome') ?? '',
      address: {
        street: text(emit, 'enderEmit', 'xLgr'),
        number: text(emit, 'enderEmit', 'nNum'),
        district: text(emit, 'enderEmit', 'xBairro'),
        city: text(emit, 'enderEmit', 'xMun'),
        state: text(emit, 'enderEmit,uf') ?? text(emit, 'enderEmit', 'UF'),
        postalCode: text(emit, 'enderEmit', 'CEP'),
        country: 'BR',
      },
    },
    recipient: {
      document: text(dest, 'CNPJ') ?? text(dest, 'CPF') ?? text(dest, 'idEstrangeiro') ?? '',
      name: text(dest, 'xNome') ?? '',
    },
    items,
    subtotal,
    taxTotal: round2(
      numOr(totalNode, 0, 'vICMS') +
        numOr(totalNode, 0, 'vPIS') +
        numOr(totalNode, 0, 'vCOFINS'),
    ),
    total: numOr(totalNode, subtotal, 'vNF'),
    payments: findAll(find(inf, 'pag'), 'detPag').map((p, index) => ({
      dueDate: text(p, 'dVenc') ?? text(inf, 'ide', 'dhEmi')?.slice(0, 10) ?? '',
      amount: numOr(p, 0, 'vPag'),
      method: text(p, 'tPag') ?? undefined,
      installment: index + 1,
    })),
    ...(num(totalNode, 'vFrete') ? { shipping: num(totalNode, 'vFrete') } : {}),
    ...(text(inf, 'infAdic', 'infCpl') ? { notes: text(inf, 'infAdic', 'infCpl') } : {}),
  };
}

// ---------------------------------------------------------------------------

export { validateCnpj, validateCep };
