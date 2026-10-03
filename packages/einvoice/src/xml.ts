import type { ValidationIssue, XmlNode } from './types.js';
import { round2 } from './types.js';
import {
  ISS_TAXES,
  SIMPLIFIED_ISS_RATE,
  VALID_UOM,
  parseIsoDate,
  suggestIsoDate,
  validateCnpj,
} from './countries/brazil.js';

/**
 * XML parsing without a dependency.
 *
 * A fiscal XML is a flat, well-behaved document: elements, text, attributes,
 * comments, no mixed content. A full XML parser would be several hundred
 * kilobytes to handle that, and every XML parser is also an XXE attack surface.
 * A focused parser that reads exactly this shape is smaller, faster, and has no
 * entity expansion at all.
 *
 * The parser is also strict about anything it does not recognise, which is what
 * we want for validation: an invoice containing a DOCTYPE is reported, not
 * expanded.
 */

export type { XmlNode };

export interface XmlParseResult {
  root: XmlNode | null;
  issues: ValidationIssue[];
}

export function parseXml(xml: string): XmlParseResult {
  const issues: ValidationIssue[] = [];
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  let line = 1;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;

    // Text between tags.
    if (lt > i) {
      const chunk = xml.slice(i, lt);
      if (stack.length > 0) stack[stack.length - 1]!.text += chunk;
      line += countNewlines(chunk);
      i = lt;
    }

    // Comments, CDATA, declarations.
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) {
        issues.push(xmlIssue('xml/unterminated-comment', 'Unterminated XML comment'));
        break;
      }
      line += countNewlines(xml.slice(lt, end));
      i = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end === -1) {
        issues.push(xmlIssue('xml/unterminated-cdata', 'Unterminated CDATA section'));
        break;
      }
      const content = xml.slice(lt + 9, end);
      if (stack.length > 0) stack[stack.length - 1]!.text += content;
      line += countNewlines(content);
      i = end + 3;
      continue;
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      if (end === -1) break;
      line += countNewlines(xml.slice(lt, end));
      i = end + 2;
      continue;
    }

    if (xml.startsWith('<!DOCTYPE', lt) || xml.startsWith('<!ENTITY', lt)) {
      // Not expanded, and reported: a fiscal invoice has no legitimate use for
      // a DTD, and entity expansion is the classic XXE vector.
      const end = xml.indexOf('>', lt);
      issues.push(
        xmlIssue(
          'xml/contains-doctype',
          'Document contains a DOCTYPE or ENTITY declaration. These are not expanded and are not valid in a fiscal XML.',
        ),
      );
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Closing tag.
    if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt);
      if (end === -1) {
        issues.push(xmlIssue('xml/unterminated-close-tag', 'Unterminated closing tag'));
        break;
      }
      const name = xml.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open) {
        issues.push(xmlIssue('xml/unexpected-close-tag', `Unexpected closing tag </${name}>`));
      } else if (open.name !== name) {
        issues.push(
          xmlIssue('xml/mismatched-tag', `Closing tag </${name}> does not match <${open.name}>`),
        );
      }
      line += countNewlines(xml.slice(lt, end));
      i = end + 1;
      continue;
    }

    // Opening or self-closing tag.
    const tagEnd = findTagEnd(xml, lt);
    if (tagEnd === -1) {
      issues.push(xmlIssue('xml/unterminated-tag', 'Unterminated tag'));
      break;
    }
    const raw = xml.slice(lt + 1, tagEnd);
    line += countNewlines(raw);

    if (raw.endsWith('/')) {
      const node = parseTag(raw.slice(0, -1), line);
      appendChild(stack, node);
      i = tagEnd + 1;
      continue;
    }

    const node = parseTag(raw, line);
    // Attach to the parent now; pushing this node onto the stack makes it the
    // parent of whatever comes next, which is how nesting is tracked.
    if (stack.length === 0) root = node;
    else appendChild(stack, node);
    stack.push(node);
    i = tagEnd + 1;
  }

  if (stack.length > 0) {
    issues.push(
      xmlIssue(
        'xml/unclosed-elements',
        `Unclosed element(s): ${stack.map((n) => n.name).join(', ')}`,
      ),
    );
  }
  if (!root) {
    issues.push(xmlIssue('xml/no-root-element', 'Document has no root element'));
  }

  return { root, issues };
}

function appendChild(stack: XmlNode[], node: XmlNode): void {
  const parent = stack[stack.length - 1];
  if (parent) parent.children.push(node);
}

function parseTag(raw: string, line: number): XmlNode {
  // The tag name ends at the first whitespace. Anchoring the name match on
  // `[A-Za-z_][\w.-]*` consumed the `-` of a hyphenated name as the start of
  // the next token, truncating every child element name.
  const qualified = /^([^\s/>]+)/.exec(raw.trim())?.[1] ?? raw.trim();
  const colon = qualified.indexOf(":");
  const prefix = colon > 0 ? qualified.slice(0, colon) : undefined;
  const name = colon > 0 ? qualified.slice(colon + 1) : qualified;

  const attributes: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w.:-]*)\s*=\s*'([^']*)'/g;
  let attr: RegExpExecArray | null;
  while ((attr = attrRe.exec(raw)) !== null) {
    const key = attr[1] ?? attr[3] ?? "";
    attributes[key] = attr[2] ?? attr[4] ?? "";
  }

  return { name, ...(prefix ? { prefix } : {}), attributes, children: [], text: '', line };
}

/** Find the `>` that closes a tag, skipping any inside quoted attributes. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * Build a schema-level issue.
 *
 * The prefix is normalised here so callers can pass either `xml/...` or a bare
 * name without producing `XML/xml/...`.
 */
function xmlIssue(ruleId: string, message: string): ValidationIssue {
  // Callers write the suffix as `xml/contains-doctype`; strip the redundant
  // lowercase prefix so the published id is `XML/contains-doctype`.
  const suffix = ruleId.replace(/^xml\//, '');
  return {
    ruleId: `XML/${suffix}`,
    severity: 'error',
    category: 'schema',
    path: '/',
    message,
    fixable: false,
  };
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Find the first descendant with a name, or undefined. */
export function find(node: XmlNode | null | undefined, ...path: string[]): XmlNode | undefined {
  let current: XmlNode | undefined = node ?? undefined;
  for (const name of path) {
    if (!current) return undefined;
    current = current.children.find((child) => child.name === name);
  }
  return current;
}

/** Find every descendant with a name. */
export function findAll(node: XmlNode | null | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const child of n.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  if (node) walk(node);
  return out;
}

/** Follow a path and return trimmed text, or undefined. */
export function text(node: XmlNode | null | undefined, ...path: string[]): string | undefined {
  const target = find(node, ...path);
  const value = target?.text.trim();
  return value ? value : undefined;
}

export function textAt(node: XmlNode | null | undefined, path: string): string | undefined {
  const target = find(node, ...path.split('/').filter(Boolean));
  const value = target?.text.trim();
  return value ? value : undefined;
}

/** Attribute value by dotted path. */
export function attr(node: XmlNode | null | undefined, name: string): string | undefined {
  const value = node?.attributes[name];
  return value ? value : undefined;
}

/**
 * Parse a numeric field.
 *
 * Returns `undefined` when the element is absent or unparseable, so callers can
 * use `??` to fall back. Returning NaN here made `num(a) ?? num(b)` silently
 * yield NaN, which then propagated into every total.
 */
export function num(node: XmlNode | null | undefined, ...path: string[]): number | undefined {
  const raw = text(node, ...path);
  if (raw === undefined) return undefined;
  // Both decimal and Brazilian comma separators are accepted in fiscal XML.
  const normalised = raw.includes(',') && !raw.includes('.') ? raw.replace(',', '.') : raw;
  const parsed = Number.parseFloat(normalised);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `num` with a numeric default, for arithmetic. */
export function numOr(node: XmlNode | null | undefined, fallback: number, ...path: string[]): number {
  return num(node, ...path) ?? fallback;
}

export function allNum(node: XmlNode, path: string[]): number[] {
  const target = find(node, ...path);
  if (!target) return [];
  return target.children
    .map((child) => child.text.trim())
    .filter(Boolean)
    .map((v) => Number.parseFloat(v.replace(',', '.')))
    .filter((n) => Number.isFinite(n));
}

/** Build a shallow map of a repeated element's children, for list items. */
export function asRecord(node: XmlNode): Record<string, XmlNode> {
  const out: Record<string, XmlNode> = {};
  for (const child of node.children) {
    const existing = out[child.name];
    if (existing) {
      // Repeat the element as siblings so nothing is silently lost.
      existing.children.push(...child.children);
      existing.text += child.text;
    } else {
      out[child.name] = child;
    }
  }
  return out;
}

/** Namespaces commonly used in fiscal XML, for display purposes. */
export const COMMON_NAMESPACES: Record<string, string> = {
  nfe: 'http://www.portalfiscal.inf.br/nfe',
  nfse: 'http://www.sped.fazenda.gov.br/nfse',
  cte: 'http://www.portalfiscal.inf.br/cte',
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
};

/**
 * Validate a Brazilian postal code (CEP).
 *
 * Shape only: eight digits, not all the same. The ninth digit Correios assigns
 * is a checksum from their internal allocation tables rather than a published
 * rule, and a strict test rejects a large share of genuine CEPs -- which is
 * worse than saying nothing, because a false rejection gets an issued invoice
 * blocked at the tax authority.
 */
export function validateCep(cep: string): { valid: boolean; reason: string } {
  const d = cep.replace(/\D/g, '');
  if (d.length !== 8) return { valid: false, reason: `CEP must have 8 digits, found ${d.length}` };
  if (/^(\d)\1{7}$/.test(d)) return { valid: false, reason: 'CEP cannot be all the same digit' };
  return { valid: true, reason: '' };
}

export {
  validateCnpj,
  parseIsoDate,
  suggestIsoDate,
  VALID_UOM,
  ISS_TAXES,
  SIMPLIFIED_ISS_RATE,
  round2,
};
