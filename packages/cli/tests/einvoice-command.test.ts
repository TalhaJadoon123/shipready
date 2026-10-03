import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runValidate, runConvert } from '../src/commands/einvoice.js';

let dir: string;

const VALID_NFSE = `<?xml version="1.0" encoding="UTF-8"?>
<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infNFS-e Id="NFS000000042">
    <ide>
      <numeroNFSe>000000042</numeroNFSe>
      <serie>1</serie>
      <dataEmissao>2026-01-15</dataEmissao>
    </ide>
    <emitente>
      <cpfCnpj>11222333000181</cpfCnpj>
      <razaoSocial>Northwind Tecnologia Ltda</razaoSocial>
    </emitente>
    <destinatario>
      <cpfCnpj>98765432000198</cpfCnpj>
      <razaoSocial>Cliente Servicos SA</razaoSocial>
    </destinatario>
    <servicos>
      <servico>
        <discriminacao>Desenvolvimento de software</discriminacao>
        <valores>
          <quantidade>10</quantidade>
          <valorUnitario>150.00</valorUnitario>
          <valorServicos>1500.00</valorServicos>
          <valorIss>30.00</valorIss>
        </valores>
        <tributos>
          <tributo><codigoTributacao>0101</codigoTributacao><aliquota>2.00</aliquota></tributo>
        </tributos>
      </servico>
    </servicos>
    <totServicos>
      <valorServicos>1500.00</valorServicos>
      <valorIss>30.00</valorIss>
      <valorTotal>1530.00</valorTotal>
    </totServicos>
    <pagamento>
      <dataPagamento>2026-02-14</dataPagamento>
      <valorPagamento>1530.00</valorPagamento>
    </pagamento>
  </infNFS-e>
</NFS-e>`;

/** The same invoice with the arithmetic deliberately wrong. */
const BROKEN_NFSE = VALID_NFSE.replace(
  '<valorServicos>1500.00</valorServicos>\n      <valorIss>30.00</valorIss>\n      <valorTotal>1530.00</valorTotal>',
  '<valorServicos>900.00</valorServicos>\n      <valorIss>30.00</valorIss>\n      <valorTotal>1530.00</valorTotal>',
);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-cli-einvoice-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('shipready validate', () => {
  it('accepts a correct Brazilian invoice', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');

    const outcome = await runValidate({ path, fix: false, json: false, cwd: dir });
    expect(outcome.valid, JSON.stringify(outcome.issues)).toBe(true);
    expect(outcome.counts.error).toBe(0);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.country).toBe('BR');
  });

  it('rejects one with contradictory arithmetic', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, BROKEN_NFSE, 'utf8');

    const outcome = await runValidate({ path, fix: false, json: false, cwd: dir });
    expect(outcome.valid).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.issues.map((i) => i.ruleId)).toContain('BR/calculation/subtotal-mismatch');
  });

  it('exits 2 when the file does not exist', async () => {
    const outcome = await runValidate({ path: join(dir, 'nope.xml'), fix: false, json: false, cwd: dir });
    expect(outcome.exitCode).toBe(2);
  });

  it('returns a result rather than throwing on garbage input', async () => {
    const path = join(dir, 'garbage.xml');
    await writeFile(path, '}{ not xml at all <<<', 'utf8');
    const outcome = await runValidate({ path, fix: false, json: false, cwd: dir });
    expect(outcome.exitCode).toBeGreaterThan(0);
    expect(outcome.valid).toBe(false);
  });

  it('reports an unsupported country plainly', async () => {
    const path = join(dir, 'ubl.xml');
    await writeFile(path, '<Invoice><ID>X</ID></Invoice>', 'utf8');
    const outcome = await runValidate({ path, fix: false, json: false, cwd: dir });
    expect(outcome.valid).toBe(false);
    expect(JSON.stringify(outcome.issues)).toMatch(/not implemented|Brazil/i);
  });

  it('emits JSON when asked', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');
    const outcome = await runValidate({ path, fix: false, json: true, cwd: dir });
    expect(() => JSON.parse(outcome.output ?? '')).not.toThrow();
  });

  it('never promises government clearance', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');
    const outcome = await runValidate({ path, fix: false, json: true, cwd: dir });
    // The disclaimer is the whole point of the tool being honest about scope.
    expect(JSON.stringify(outcome)).not.toMatch(/cleared|clearance granted|accepted by SEFAZ/i);
  });
});

describe('shipready validate --fix', () => {
  it('corrects the arithmetic and re-validates', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, BROKEN_NFSE, 'utf8');

    const outcome = await runValidate({ path, fix: true, json: true, cwd: dir });
    expect(outcome.fixed?.changes ?? 0).toBeGreaterThan(0);
    expect(outcome.fixed?.document.subtotal).toBe(1500);
    // Every change is recorded for the audit trail.
    for (const change of outcome.fixed?.applied ?? []) {
      expect(change).toHaveProperty('from');
      expect(change).toHaveProperty('to');
      expect(change.ruleId).toBeTruthy();
    }
    expect(outcome.fixed?.remainingErrors).toBe(0);
  });

  it('changes nothing on a correct invoice', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');
    const outcome = await runValidate({ path, fix: true, json: true, cwd: dir });
    expect(outcome.fixed?.changes).toBe(0);
  });

  it('does not invent a tax rate', async () => {
    const noTax = VALID_NFSE.replace(/<tributos>[\s\S]*?<\/tributos>/, '');
    const path = join(dir, 'invoice.xml');
    await writeFile(path, noTax, 'utf8');

    const outcome = await runValidate({ path, fix: true, json: true, cwd: dir });
    const rates = (outcome.fixed?.document.items ?? []).map((i) => i.taxCodes[0]?.rate);
    expect(rates.every((r) => r === undefined)).toBe(true);
  });

  it('writes the corrected document when asked', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, BROKEN_NFSE, 'utf8');
    const output = join(dir, 'invoice.fixed.xml');

    await runValidate({ path, fix: true, json: true, cwd: dir, output });
    const written = await readFile(output, 'utf8');
    expect(written).toContain('<valorServicos>1500.00</valorServicos>');
  });
});

describe('shipready convert', () => {
  it('converts a parsed invoice to CSV', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');

    const outcome = await runConvert({ path, to: 'csv', cwd: dir });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain('invoice_number');
    expect(outcome.output).toContain('000000042');
  });

  it('converts to NFS-e XML', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');

    const outcome = await runConvert({ path, to: 'xml', cwd: dir });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain('<NFS-e');
    // The output warns that a signature is required before submission.
    expect(JSON.stringify(outcome.warnings)).toMatch(/signature/i);
  });

  it('converts to JSON', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');

    const outcome = await runConvert({ path, to: 'json', cwd: dir });
    const parsed = JSON.parse(outcome.output);
    expect(parsed.number).toBe('000000042');
  });

  it('reports an unknown target', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');
    const outcome = await runConvert({ path, to: 'pdf' as never, cwd: dir });
    expect(outcome.exitCode).toBe(2);
  });

  it('writes the converted document to a file', async () => {
    const path = join(dir, 'invoice.xml');
    await writeFile(path, VALID_NFSE, 'utf8');
    const output = join(dir, 'out.csv');

    await runConvert({ path, to: 'csv', cwd: dir, output });
    const written = await readFile(output, 'utf8');
    expect(written).toContain('000000042');
  });

  it('refuses to convert an unparseable document', async () => {
    const path = join(dir, 'garbage.xml');
    await writeFile(path, '}{ nonsense', 'utf8');
    const outcome = await runConvert({ path, to: 'csv', cwd: dir });
    expect(outcome.exitCode).toBeGreaterThan(0);
  });
});