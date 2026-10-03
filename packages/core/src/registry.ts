import type { PluginRegistryLike, RegisterOptions, Scanner } from './types.js';

/**
 * Registry for scanners, built-in and third-party.
 *
 * A plugin is just an object satisfying `Scanner`. Third parties register
 * against a public API so that a security scanner, a bespoke internal rule set,
 * or a whole company compliance pack can all be dropped in without patching
 * the engine.
 *
 * Ids are namespaced (`vendor/name`) and duplicates are rejected loudly:
 * silently shadowing a built-in rule is a nightmare to debug.
 */
export class PluginRegistry implements PluginRegistryLike {
  private readonly scanners = new Map<string, Scanner>();
  private readonly order: string[] = [];

  constructor(scanners: readonly Scanner[] = []) {
    for (const s of scanners) this.register(s);
  }

  register(scanner: Scanner, options: RegisterOptions = {}): void {
    validateScanner(scanner);
    const existing = this.scanners.get(scanner.id);
    if (existing && !options.override) {
      throw new Error(
        `Scanner "${scanner.id}" is already registered. ` +
          `Pass { override: true } to replace it, or give the plugin a different id.`,
      );
    }
    if (!existing) this.order.push(scanner.id);
    this.scanners.set(scanner.id, scanner);
  }

  unregister(id: string): boolean {
    if (!this.scanners.has(id)) return false;
    this.scanners.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  get(id: string): Scanner | undefined {
    return this.scanners.get(id);
  }

  all(): readonly Scanner[] {
    return this.order.map((id) => this.scanners.get(id)!).filter(Boolean);
  }

  /** Scanners whose id starts with one of the given namespaces. */
  byNamespace(...namespaces: string[]): Scanner[] {
    return this.all().filter((s) => namespaces.some((n) => s.id.startsWith(`${n}/`)));
  }

  byCategory(category: string): Scanner[] {
    return this.all().filter((s) => s.categories.includes(category as never));
  }

  get size(): number {
    return this.scanners.size;
  }

  /** Registration order, for deterministic scan output. */
  ids(): string[] {
    return [...this.order];
  }

  clone(): PluginRegistry {
    return new PluginRegistry(this.all());
  }
}

function validateScanner(scanner: Scanner): void {
  if (!scanner || typeof scanner !== 'object') {
    throw new TypeError('A scanner must be an object');
  }
  for (const field of ['id', 'name', 'description'] as const) {
    if (typeof scanner[field] !== 'string' || scanner[field].length === 0) {
      throw new TypeError(`Scanner is missing a valid "${field}"`);
    }
  }
  if (!scanner.id.includes('/')) {
    throw new TypeError(
      `Scanner id "${scanner.id}" must be namespaced, e.g. "readiness/error-handling/no-global-handler"`,
    );
  }
  if (!Array.isArray(scanner.categories) || scanner.categories.length === 0) {
    throw new TypeError(`Scanner "${scanner.id}" must declare at least one category`);
  }
  if (typeof scanner.scan !== 'function') {
    throw new TypeError(`Scanner "${scanner.id}" must implement scan(context)`);
  }
}

/** Helper for plugin authors: build a scanner without a class. */
export function defineScanner(input: {
  id: string;
  name: string;
  description: string;
  categories: Scanner['categories'];
  version?: string;
  scan: Scanner['scan'];
}): Scanner {
  return { ...input };
}
