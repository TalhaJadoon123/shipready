/**
 * XML fixtures for the e-invoice tests.
 *
 * `VALID_NFSE_XML` is the national standard layout (ADN 15/2023) with
 * internally consistent arithmetic, so it validates cleanly.
 * `VALID_XML_WITH_ERRORS` is the same document with the mistakes a real export
 * produces: a wrong tax total, a due date before the issue date, and an
 * unrecognised tax code.
 * `VALID_UBL` is a UBL 2.1 invoice, which is the other format a supplier is
 * likely to hand you.
 */

export const VALID_NFSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <email>financeiro@northwind.example</email>
      <inscricaoMunicipal>1234567</inscricaoMunicipal>
      <endereco>
        <municipio>Sao Paulo</municipio>
        <uf>SP</uf>
        <cep>01310100</cep>
      </endereco>
    </emitente>
    <destinatario>
      <cpfCnpj>98765432000198</cpfCnpj>
      <razaoSocial>Cliente Servicos SA</razaoSocial>
      <email>financeiro@cliente.example</email>
    </destinatario>
    <servicos>
      <servico>
        <codigoServico>01.01</codigoServico>
        <discriminacao>Desenvolvimento de software sob medida</discriminacao>
        <valores>
          <quantidade>10</quantidade>
          <valorUnitario>150.00</valorUnitario>
          <valorServicos>1500.00</valorServicos>
          <valorIss>30.00</valorIss>
          <moeda>BRL</moeda>
        </valores>
        <tributos>
          <tributo>
            <codigoTributacao>0101</codigoTributacao>
            <aliquota>2.00</aliquota>
          </tributo>
        </tributos>
      </servico>
    </servicos>
    <totServicos>
      <valorServicos>1500.00</valorServicos>
      <valorIss>30.00</valorIss>
      <valorTotal>1530.00</valorTotal>
    </totServicos>
    <servicoPrestado>Desenvolvimento de sistema de gestao</servicoPrestado>
    <pagamento>
      <formaPagamento>03</formaPagamento>
      <dataPagamento>2026-02-14</dataPagamento>
      <valorPagamento>1530.00</valorPagamento>
    </pagamento>
  </infNFS-e>
</NFS-e>`;

export const VALID_XML_WITH_ERRORS = `<?xml version="1.0" encoding="UTF-8"?>
<NFS-e xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infNFS-e Id="NFS000000043">
    <ide>
      <numeroNFSe>000000043</numeroNFSe>
      <serie>1</serie>
      <dataEmissao>2026-01-15</dataEmissao>
    </ide>
    <emitente>
      <cpfCnpj>11222333000199</cpfCnpj>
      <razaoSocial>Northwind Tecnologia Ltda</razaoSocial>
    </emitente>
    <destinatario>
      <cpfCnpj>98765432000198</cpfCnpj>
      <razaoSocial>Cliente Servicos SA</razaoSocial>
    </destinatario>
    <servicos>
      <servico>
        <discriminacao>Consultoria</discriminacao>
        <valores>
          <quantidade>5</quantidade>
          <valorUnitario>200.00</valorUnitario>
          <valorServicos>1000.00</valorServicos>
          <valorIss>55.00</valorIss>
          <moeda>BRL</moeda>
        </valores>
        <tributos>
          <tributo>
            <codigoTributacao>99999</codigoTributacao>
            <aliquota>5.00</aliquota>
          </tributo>
        </tributos>
      </servico>
    </servicos>
    <totServicos>
      <valorServicos>900.00</valorServicos>
      <valorIss>55.00</valorIss>
      <valorTotal>955.00</valorTotal>
    </totServicos>
    <pagamento>
      <formaPagamento>01</formaPagamento>
      <dataPagamento>2026-01-10</dataPagamento>
      <valorPagamento>955.00</valorPagamento>
    </pagamento>
  </infNFS-e>
</NFS-e>`;

export const VALID_UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>INV-2026-001</cbc:ID>
  <cbc:IssueDate>2026-01-15</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID schemeID="VAT">IE123456789</cbc:CompanyID>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Acme Supplies Ltd</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      <cac:ElectronicMail>billing@acme.example</cac:ElectronicMail>
      <cac:PostalAddress>
        <cbc:StreetName>Main Street</cbc:StreetName>
        <cbc:BuildingNumber>12</cbc:BuildingNumber>
        <cbc:CityName>Dublin</cbc:CityName>
        <cbc:PostalZone>D02</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>IE</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID schemeID="VAT">DE987654321</cbc:CompanyID>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Beta Services GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">230.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:PayableAmount currencyID="EUR">1230.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Consulting services</cbc:Name>
      <cbc:ClassifiedCode listID="UNSPSC">80141600</cbc:ClassifiedCode>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>2026-02-14</cbc:PaymentDueDate>
  </cac:PaymentMeans>
</Invoice>`;

/** A minimal NF-e for goods, to prove the goods layout also parses. */
export const VALID_NFE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe versao="4.00" Id="NFe35260111222333000181550010000000421000000017">
      <ide>
        <nNF>42</nNF>
        <serie>1</serie>
        <dhEmi>2026-01-15T10:00:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>11222333000181</CNPJ>
        <xNome>Northwind Tecnologia Ltda</xNome>
        <enderEmit>
          <xLgr>Av Paulista</xLgr>
          <nNum>1000</nNum>
          <xBairro>Bela Vista</xBairro>
          <xMun>Sao Paulo</xMun>
          <UF>SP</UF>
          <CEP>01310100</CEP>
        </enderEmit>
      </emit>
      <dest>
        <CNPJ>98765432000198</CNPJ>
        <xNome>Cliente Servicos SA</xNome>
      </dest>
      <det>
        <prod>
          <cProd>SKU-1</cProd>
          <xProd>Widget</xProd>
          <qTrib>2</qTrib>
          <uTrib>UN</uTrib>
          <vProd>100.00</vProd>
        </prod>
        <imposto>
          <ICMS>
            <ICMS00>
              <orig>0</orig>
              <CST>00</CST>
            </ICMS00>
          </ICMS>
        </imposto>
      </det>
      <total>
        <ICMSTot>
          <vProd>100.00</vProd>
          <vICMS>18.00</vICMS>
          <vNF>118.00</vNF>
        </ICMSTot>
      </total>
      <pag>
        <detPag>
          <tPag>03</tPag>
          <vPag>118.00</vPag>
          <dVenc>2026-02-14</dVenc>
        </detPag>
      </pag>
    </infNFe>
  </NFe>
</nfeProc>`;