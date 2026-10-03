/**
 * A gitignore-flavoured matcher, implemented well enough to stop ShipReady
 * walking `node_modules` 40,000 times and to honour a repo's own
 * `.shipreadyignore`. Not a byte-perfect reimplementation of gitignore: no
 * negation edge cases beyond the common `!` form, no character classes.
 */

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  re: RegExp;
}

export class IgnoreMatcher {
  private readonly rules: IgnoreRule[] = [];

  constructor(text?: string) {
    if (text) this.addText(text);
  }

  addText(text: string): this {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      this.add(line.trim());
    }
    return this;
  }

  add(pattern: string): this {
    if (!pattern) return this;
    let p = pattern;
    const negated = p.startsWith('!');
    if (negated) p = p.slice(1);
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.includes('/');
    if (p.startsWith('/')) p = p.slice(1);
    if (!p) return this;
    this.rules.push({
      pattern: p,
      negated,
      dirOnly,
      anchored,
      re: globToRegExp(p, anchored),
    });
    return this;
  }

  /**
   * `path` must be a repo-relative POSIX path. `isDir` lets directory-only
   * patterns such as `build/` prune whole subtrees during the walk.
   */
  ignores(path: string, isDir = false): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir && !this.pathIsUnderDir(path, rule.pattern)) continue;
      if (!rule.re.test(path)) continue;
      ignored = !rule.negated;
    }
    return ignored;
  }

  private pathIsUnderDir(path: string, dir: string): boolean {
    return path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);
  }

  get size(): number {
    return this.rules.length;
  }
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading directories.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  // A non-anchored pattern matches at any depth, like gitignore.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${out}(?:/.*)?$`);
}

/** Directories that are never worth scanning, in any language. */
export const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.output',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  'vendor',
  'target',
  'Pods',
  '.gradle',
  '.idea',
  '.vscode',
  'bower_components',
  '.terraform',
  'vendor/bundle',
  '.dart_tool',
  '.expo',
  '.angular',
  '.parcel-cache',
  '.vercel',
  '.netlify',
  'storybook-static',
  '.wrangler',
  '.docusaurus',
  '.vinxi',
  '.fleet',
  '.pnpm-store',
  '.yarn',
  'tmp',
  'temp',
  'logs',
  '.DS_Store',
] as const;

/**
 * Ignored files.
 *
 * Lockfiles are deliberately NOT listed: they are text, they are usually
 * under 500 kB, and two deployment rules need to know whether one exists.
 * They are excluded from line counting instead, in `countRepoLines`.
 */
const DEFAULT_IGNORED_FILES = [
  '.DS_Store',
  'Thumbs.db',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '*.svg',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.pdf',
  '*.zip',
  '*.gz',
  '*.tar',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp4',
  '*.mp3',
  '*.wav',
  '*.db',
  '*.sqlite',
  '*.bin',
] as const;

/** Human-readable "we did not scan this" explanation for the report footer. */
export const IGNORE_REASONS: Record<string, string> = {
  node_modules: 'third-party dependencies',
  dist: 'build output',
  build: 'build output',
  out: 'build output',
  '.next': 'build output',
  coverage: 'coverage artifacts',
  '.git:': 'git internals',
  'vendor': 'vendored dependencies',
  target: 'compiled artifacts',
};

export function buildDefaultIgnoreMatcher(extraText?: string): IgnoreMatcher {
  const m = new IgnoreMatcher();
  for (const d of DEFAULT_IGNORED_DIRS) m.add(`${d}/`);
  for (const f of DEFAULT_IGNORED_FILES) m.add(f);
  if (extraText) m.addText(extraText);
  return m;
}

export function isBinaryPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mp3|wav|db|sqlite|bin|exe|dll|so|dylib|jar|class|wasm)$/i.test(
    path,
  );
}
