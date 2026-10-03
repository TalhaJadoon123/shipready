import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { filesWithExts } from './helpers.js';

const UI_EXTS = ['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html'];
const INTERACTIVE = /\bon(Click|DoubleClick|MouseDown|MouseUp|KeyDown|KeyUp|KeyPress|TouchStart|TouchEnd|ContextMenu|Scroll|Input|Change|Focus|Blur|Submit)\s*=/;

/** aria-* and role values that give a control an accessible name. */
const NAMED_ATTR = /(aria-label|aria-labelledby|aria-describedby|role\s*=|title\s*=)/;

export const accessibilityRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/accessibility/missing-alt-text',
      name: 'Image with no alt text',
      category: 'accessibility',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.9,
      effortMinutes: 10,
      fixable: false,
      description:
        'An image has no `alt` attribute. A screen reader announces the filename. For a decorative image the correct value is `alt=""`, which is different from omitting the attribute -- and for a meaningful image the text has to describe the information the image conveys, not its appearance.',
      remediation:
        'Add `alt` to every image. Use `alt=""` for decoration, a description for content images, and `alt` for an icon button with no other label. This is also the largest single win for SEO and for images that fail to load.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-1.1.1', 'seo'],
      references: ['https://www.w3.org/WAI/tutorials/images/decorative/'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...UI_EXTS)) {
        if (file.hasExplanatoryCommentNear(1, ['decorative', 'intentionally', 'aria-hidden', 'presentation'])) continue;
        for (const hit of file.matchNoComments(/<img\b/g)) {
          const tag = readTag(file.content, hit.index);
          if (tag === null) continue;
          if (/\balt\s*=/.test(tag)) continue;
          // A next/image or <Image> component forwards alt; require it explicitly.
          if (/^(<Image|<CldImage|<SmartImage)\b/.test(tag) && !/\balt\s*=/.test(tag)) {
            yield emit({
              path: file.path,
              line: hit.line,
              snippet: tag.slice(0, 120),
              evidence: 'image component without an alt prop',
            });
            continue;
          }
          if (/\baria-hidden\s*=\s*["'{]true/.test(tag)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: tag.slice(0, 120),
            evidence: '<img> with no alt attribute -- screen readers announce the file name instead',
          });
        }
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/accessibility/missing-aria-label',
      name: 'Icon-only control with no accessible name',
      category: 'accessibility',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 10,
      fixable: false,
      description:
        'A button or link contains only an icon, so it has no accessible name. Screen reader users hear "button" with nothing else, and voice control users cannot say what to click. This is a WCAG 2.1 AA failure and it is the most common real accessibility bug after missing alt text.',
      remediation:
        'Add `aria-label` describing the action ("Delete invoice", not "trash icon"), and if there is visible text, use `aria-labelledby` pointing at it instead. Keep the label unique per page.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-4.1.2', 'aria'],
      references: ['https://www.w3.org/WAI/ARIA/apg/patterns/button/'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...UI_EXTS)) {
        for (const hit of file.matchNoComments(/<(button|a)\b/g)) {
          const open = readTag(file.content, hit.index);
          if (open === null) continue;
          const body = readElementBody(file.content, hit.index);
          if (body === null) continue;
          if (NAMED_ATTR.test(open)) continue;
          // Body is text content rather than markup.
          if (body.trim() !== '' && !/^<[a-z]/.test(body.trim())) continue;
          if (!/^<(svg|i|img|Icon|Lucide|span)\b/i.test(body.trim())) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: open.slice(0, 120),
            evidence: `icon-only <${hit.match.replace('<', '')}> with no aria-label, title or visible text`,
          });
        }
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/accessibility/non-semantic-interaction',
      name: 'Click handler on a non-interactive element',
      category: 'accessibility',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.85,
      effortMinutes: 15,
      fixable: false,
      description:
        'A click handler sits on a `div` or `span`. The element is not focusable and has no keyboard handler, so it cannot be reached with Tab and cannot be activated with Enter or Space. It is invisible to keyboard and switch users entirely.',
      remediation:
        'Use the semantic element: `<button>` for actions, `<a href>` for navigation. If you cannot change the markup, add `role="button"`, `tabIndex={0}`, and an `onKeyDown` handler for Enter and Space.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-2.1.1', 'keyboard'],
      references: ['https://www.w3.org/WAI/WCAG22/Understanding/keyboard'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...UI_EXTS)) {
        for (const hit of file.matchNoComments(/<(div|span|li|td|tr|p|section|article)\b/g)) {
          const open = readTag(file.content, hit.index);
          if (open === null) continue;
          if (!INTERACTIVE.test(open)) continue;
          if (/\brole\s*=\s*["'{](button|link|menuitem|checkbox|tab|switch)/.test(open)) continue;
          if (/\btabIndex\s*=/.test(open)) continue;
          if (file.hasExplanatoryCommentNear(hit.line, ['shipready-ignore', 'keyboard', 'role is set', 'accessibility reviewed'])) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: open.slice(0, 140),
            evidence: `on* handler on <${hit.match.replace('<', '')}> with no role or tabIndex -- unreachable by keyboard`,
          });
        }
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/accessibility/no-html-lang',
      name: 'HTML document has no lang attribute',
      category: 'accessibility',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.85,
      effortMinutes: 5,
      fixable: true,
      description:
        'The document element has no `lang`. Screen readers pick a pronunciation based on it; without one they guess, which makes the page unintelligible in some languages and mispronounced in others.',
      remediation: 'Set `<html lang="en">` in your root layout. Use the correct BCP 47 tag for localised pages and add `hreflang` alternates when you serve more than one language.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-3.1.1'],
      references: ['https://www.w3.org/WAI/WCAG22/Understanding/language-of-page'],
    },
    function* (ctx, emit) {
      const layouts = ctx.files().filter((f) => /(^|\/)(layout|_document|index\.html)\.(tsx|jsx|html|astro|svelte|vue)$/.test(f));
      if (layouts.length === 0) return;
      for (const path of layouts.slice(0, 5)) {
        const file = filesWithExts(ctx, path.slice(path.lastIndexOf('.'))).find((f) => f.path === path);
        if (!file) continue;
        const hit = /<html\b[^>]*>/.exec(file.content);
        if (!hit) continue;
        if (/\blang\s*=/.test(hit[0])) continue;
        yield emit({
          path: file.path,
          line: 1,
          snippet: hit[0].slice(0, 100),
          evidence: '<html> element without a lang attribute',
          severity: 'low',
          impact: 'cosmetic',
          effortMinutes: 5,
        });
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/accessibility/no-positive-tabindex',
      name: 'Positive tabindex breaks natural focus order',
      category: 'accessibility',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.9,
      effortMinutes: 15,
      fixable: false,
      description:
        'A positive `tabindex` overrides the document focus order for every element after it, so keyboard navigation jumps around the page in a way that does not match what the user sees. It is almost always a workaround for a broken DOM order.',
      remediation:
        'Fix the DOM order instead: put the elements in the sequence you want them focused. Use `tabIndex={0}` for a natural stop and `tabIndex={-1}` for programmatic focus only. Never use a positive value.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'focus-order'],
      references: ['https://www.w3.org/WAI/WCAG22/Understanding/focus-order'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...UI_EXTS)) {
        for (const hit of file.matchNoComments(/tab[Ii]ndex\s*=\s*["'{]?([1-9]\d*)/g)) {
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: `positive tabindex (${/\d+/.exec(hit.text)?.[0]}) overrides document focus order`,
            severity: 'low',
            impact: 'cosmetic',
            effortMinutes: 15,
          });
        }
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),

  defineRule(
    {
      id: 'readiness/accessibility/no-focus-styles',
      name: 'Focus outline removed with no replacement',
      category: 'accessibility',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.85,
      effortMinutes: 20,
      fixable: true,
      description:
        'A global `outline: none` removes the focus indicator from every focusable element. Keyboard users then have no way to tell where they are on the page. This is a very common "make it look clean" change.',
      remediation:
        'Replace it with a visible custom focus style: `:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }`. That gives you a keyboard-only indicator that does not appear on mouse clicks.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-2.4.7', 'css'],
      references: ['https://www.w3.org/WAI/WCAG22/Understanding/focus-visible'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, '.css', '.scss', '.sass', '.less', '.tsx', '.ts', '.jsx', '.js')) {
        const hits = file.matchNoComments(/outline\s*:\s*(none|0)\b|outline\s*:\s*[^;]*solid\s+transparent/g);
        const removals = hits.filter((h) => !/focus-visible/.test(file.content.slice(Math.max(0, h.index - 200), h.index + 200)));
        if (removals.length === 0) continue;
        if (/:focus-visible\s*\{[^}]*outline\s*:\s*(?!none|0)/.test(file.content)) continue;
        yield emit({
          path: file.path,
          line: removals[0]!.line,
          snippet: removals[0]!.text,
          evidence: `\`outline: none\` with no :focus-visible replacement -- keyboard users lose the focus indicator`,
        });
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/accessibility/no-form-labels',
      name: 'Form input with no associated label',
      category: 'accessibility',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 25,
      fixable: false,
      description:
        'An input has no label, placeholder or `aria-label`. Placeholders are not labels: they disappear on focus and are often too low-contrast to read. Screen reader users get "edit text" with no indication of what belongs in it.',
      remediation:
        'Give every input an explicit `<label htmlFor>`, or `aria-label` when a visible label would be redundant. This also fixes autofill failures and improves conversion for everyone.',
      compliance: [COMPLIANCE.owaspA05],
      cwe: 'CWE-1021',
      tags: ['wcag', 'wcag-3.3.2', 'forms'],
      references: ['https://www.w3.org/WAI/tutorials/forms/labels/'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...UI_EXTS)) {
        if (!/<input\b/.test(file.content) && !/<select\b/.test(file.content) && !/<textarea\b/.test(file.content)) continue;
        if (file.hasExplanatoryCommentNear(1, ['search input', 'hidden', 'sr-only label', 'aria'])) continue;
        for (const hit of file.matchNoComments(/<(input|select|textarea)\b/g)) {
          const tag = readTag(file.content, hit.index);
          if (tag === null) continue;
          if (/\btype\s*=\s*["']?(hidden|submit|button|reset|checkbox|radio)/.test(tag)) continue;
          if (/\baria-label(ledby)?\s*=/.test(tag)) continue;
          if (/\bid\s*=\s*["']([\w-]+)["']/.test(tag)) {
            const id = /\bid\s*=\s*["']([\w-]+)["']/.exec(tag)?.[1];
            if (id && new RegExp(`<label[^>]*\\bfor\\s*=\\s*["'{]?["']?${escapeRe(id)}\\b`).test(file.content)) continue;
          }
          if (/<(label)\b[^>]*>\s*\{?\s*(?:<[^>]+>\s*)*[\w{]/.test(file.content.slice(hit.index + tag.length, hit.index + tag.length + 200))) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: tag.slice(0, 120),
            evidence: `<${hit.match.replace('<', '')}> with no label, aria-label or associated <label for>`,
          });
        }
      }
    },
    (ctx) => ctx.project.components.length > 0,
  ),
];

// ---------------------------------------------------------------------------

function readTag(content: string, startIndex: number): string | null {
  let i = startIndex;
  let depth = 0;
  while (i < content.length && i < startIndex + 2000) {
    const c = content[i];
    if (c === '>') {
      return content.slice(startIndex, i + 1);
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === '/' && depth === 0 && content[i + 1] === '>') return content.slice(startIndex, i + 2);
    i++;
  }
  return null;
}

function readElementBody(content: string, startIndex: number): string | null {
  const tag = readTag(content, startIndex);
  if (!tag) return null;
  const name = /<([a-zA-Z][\w-]*)/.exec(tag)?.[1];
  if (!name) return null;
  const closeIdx = content.indexOf(`</${name}`, startIndex);
  if (closeIdx < 0) return content.slice(startIndex + tag.length, startIndex + tag.length + 400);
  return content.slice(startIndex + tag.length, Math.min(closeIdx, startIndex + tag.length + 600));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}