import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Auto-fix templates.
 *
 * The generated files live as real files under `templates/` rather than as
 * template literals in TypeScript. Two reasons, both learned the hard way:
 *
 *  1. A Dockerfile, a GitHub Actions workflow or a Python module is full of
 *     backticks, `${...}` and `"""`. Escaping those correctly inside a
 *     template literal is a bug factory.
 *  2. `{{ }}` placeholders collide with GitHub Actions and Helm syntax.
 *     Using `<<NAME>>` means a template can contain braces verbatim.
 *
 * Placeholders substituted at generation time:
 *   <<PROJECT_TYPE>>, <<IS_PYTHON>>, <<HAS_DB>>, <<TESTS_DIR>>
 */

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(here, 'templates');

export type TemplateVars = {
  PROJECT_TYPE: string;
  IS_PYTHON: string;
  HAS_DB: string;
  TESTS_DIR: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
};

const cache = new Map<string, string>();

export function readTemplate(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const abs = join(TEMPLATE_DIR, name);
  const text = readFileSync(abs, 'utf8');
  cache.set(name, text);
  return text;
}

/**
 * Substitute `<<NAME>>` placeholders.
 *
 * Every placeholder has a default, so a template can never render a literal
 * `<<NAME>>` into a user's repository -- which would be a broken file with no
 * explanation of what went wrong.
 */
export function render(name: string, vars: Partial<TemplateVars> = {}): string {
  const defaults: TemplateVars = {
    PROJECT_TYPE: 'node',
    IS_PYTHON: 'false',
    HAS_DB: 'false',
    TESTS_DIR: 'tests',
    GITHUB_WORKFLOW: '${{ github.workflow }}',
    GITHUB_REF: '${{ github.ref }}',
  };
  const merged = { ...defaults, ...vars };
  return readTemplate(name).replace(/<<([A-Z_]+)>>/g, (match, key: string) => {
    const value = (merged as Record<string, string>)[key];
    if (value !== undefined) return value;
    // An unknown placeholder is a template bug; render it visibly rather than
    // silently producing a file that will not work.
    return `/* ShipReady: unresolved template placeholder ${match} */`;
  });
}

/** Every template shipped, for the test that checks they all render. */
export function listTemplates(): string[] {
  return readdirSync(TEMPLATE_DIR).filter((f) => !f.startsWith('.'));
}