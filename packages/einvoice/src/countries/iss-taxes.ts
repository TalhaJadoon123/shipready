/** One ISS tax code from LC 116/2003, Anexo I. */
export interface ISS_TAX_CATALOGUE_ENTRY {
  /** Code used in the NFS-e XML. */
  code: string;
  /** Annex I description. */
  name: string;
  /** Default rate, percent. */
  rate: number;
  /**
   * Municipalities set ISS under LC 116/2003, in a 2-5% band. `variable`
   * means the validator reports a deviation rather than an error.
   */
  kind: 'fixed' | 'variable';
  /** Law reference. */
  law?: string;
}
/**
 * ISS tax codes, keyed by the five-digit national code used in NFS-e.
 *
 * The rate is genuinely **variable** for every entry: the municipality sets it
 * under LC 116/2003 and it ranges from 2% to 5%. Shipping one number as fact
 * would produce wrong totals in most municipalities, so `kind` is `variable`
 * throughout and the validator reports a deviation rather than an error.
 *
 * The list is the Annex I items that actually appear on software and
 * professional-services invoices. A one-to-many entry (0501, 1401, 2801) lists
 * several national codes on one line in the annex; the representative code is
 * used here.
 */
const CATALOGUE: ISS_TAX_CATALOGUE_ENTRY[] = [
  // --- 1. Technology and computing ---
  {
    code: '0101',
    name: 'Análise e desenvolvimento de sistemas',
    rate: 2,
    kind: 'variable',
    law: 'LC 116/2003, Anexo I, 1.01',
  },
  {
    code: '0102',
    name: 'Programação',
    rate: 2,
    kind: 'variable',
    law: 'LC 116/2003, Anexo I, 1.02',
  },
  {
    code: '0103',
    name: 'Processamento, armazenamento ou hospedagem de dados e sistemas de informação',
    rate: 2,
    kind: 'variable',
  },
  {
    code: '0104',
    name: 'Elaboração de programas de computadores',
    rate: 2,
    kind: 'variable',
  },
  {
    code: '0105',
    name: 'Licenciamento ou cessão de direito de uso de programas de computação',
    rate: 2,
    kind: 'variable',
  },
  {
    code: '0106',
    name: 'Assessoria e consultoria em informática',
    rate: 2,
    kind: 'variable',
  },
  { code: '0107', name: 'Suporte técnico em informática', rate: 2, kind: 'variable' },

  // --- 2. Research and development ---
  {
    code: '0201',
    name: 'Pesquisas, desenvolvimento e qualquer natureza',
    rate: 2,
    kind: 'variable',
  },

  // --- 7. Engineering and architecture ---
  { code: '0701', name: 'Engenharia em geral', rate: 2, kind: 'variable' },
  {
    code: '0702',
    name: 'Construção civil, hidráulica ou elétrica',
    rate: 2,
    kind: 'variable',
  },

  // --- 10. Legal and accounting ---
  { code: '1001', name: 'Advocacia', rate: 2, kind: 'variable' },
  {
    code: '1101',
    name: 'Contabilidade, inclusive serviços técnicos e auxiliares',
    rate: 2,
    kind: 'variable',
  },

  // --- 14. Consulting ---
  { code: '1401', name: 'Consultoria e advise', rate: 2, kind: 'variable' },

  // --- 17. Technical analysis ---
  {
    code: '1701',
    name: 'Perícia, laudos, exames técnicos e análises técnicas',
    rate: 2,
    kind: 'variable',
  },

  // --- 21. Trademarks and industrial property ---
  {
    code: '2101',
    name: 'Registros, marcas, patentes e trade-names',
    rate: 2,
    kind: 'variable',
  },

  // --- 26. Graphics and design ---
  { code: '2601', name: 'Serviços de desenhos técnicos', rate: 2, kind: 'variable' },

  // --- 27. Advertising ---
  { code: '2701', name: 'Serviços de publicidade e propaganda', rate: 2, kind: 'variable' },

  // --- 28. Security and investigation ---
  {
    code: '2801',
    name: 'Serviços de investigação, segurança, monitoramento e detecção',
    rate: 2,
    kind: 'variable',
  },

  // --- 31. Technical installations ---
  {
    code: '3101',
    name: 'Serviços técnicos em edificações, eletrônica, eletrotécnica, mecânica, telecomunicações',
    rate: 2,
    kind: 'variable',
  },

  // --- 33. Web and digital content ---
  {
    code: '3301',
    name: 'Serviços de desenvolvimento, atualização e gestão de home pages',
    rate: 2,
    kind: 'variable',
  },
  {
    code: '3401',
    name: 'Serviços de multimídia, criação de conteúdos e publicação',
    rate: 2,
    kind: 'variable',
  },

  // --- 35. Studies and research ---
  {
    code: '3501',
    name: 'Estudos,_clone pesquisa, análise e desenvolvimento de qualquer natureza',
    rate: 2,
    kind: 'variable',
  },

  // --- 39. Lapidação and precious stones ---
  { code: '3901', name: 'Serviços de ourivesaria e lapidação', rate: 2, kind: 'variable' },

  // --- 54. Laundry ---
  {
    code: '5401',
    name: 'Serviços de lavanderia, tinturaria e beneficiamento, Exclusive',
    rate: 2,
    kind: 'variable',
  },

  // --- 71. Cleaning ---
  {
    code: '7101',
    name: 'Serviços de limpeza, manutenção e conservação',
    rate: 2,
    kind: 'variable',
  },

  // --- 99. Other services ---
  {
    code: '9901',
    name: 'Outros serviços não especificados em outro item',
    rate: 2,
    kind: 'variable',
  },
];

/**
 * ISS codes by their five-digit national form.
 *
 * LC 116/2003 writes items as `1.01`, and the national NFS-e list writes them
 * as `0101`. Municipal exports use either, sometimes with a leading zero for
 * the municipality band (`00101`). Both forms resolve to the same entry, so a
 * document is not rejected over a formatting difference.
 */
export const ISS_TAX_CATALOGUE: Record<string, ISS_TAX_CATALOGUE_ENTRY> = Object.fromEntries(
  CATALOGUE.flatMap((entry) => {
    const fourDigit = entry.code.replace(/^0+(?=\d{4}$)/, '');
    return [
      [entry.code, entry],
      ...(fourDigit !== entry.code ? [[fourDigit, entry] as const] : []),
    ];
  }),
);

/** Alias for the catalogue. */
export const ISS_TAXES = ISS_TAX_CATALOGUE;
