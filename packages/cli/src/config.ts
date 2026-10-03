import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ScanConfig, Severity } from '@shipready/core';

/**
 * `.shipready.yml` loader.
 *
 * Deliberately tolerant: a malformed config prints a warning and falls back to
 * defaults rather than refusing to scan. A tool that blocks your build because
 * of a stray tab is a tool people delete.
 */
export interface ShipReadyConfig {
  version: number;
  scan: {
    threshold: number;
    disable: string[];
    minConfidence: number;
    minSeverity?: Severity;
    exclude: string[];
    include: string[];
  };
  fix: { limit: number };
  observe: { costBudget: number; costPerTrace: number };
  compliance: { jurisdiction: string; frameworks: string[] };
}

export const DEFAULT_CONFIG: ShipReadyConfig = {
  version: 1,
  scan: { threshold: 50, disable: [], minConfidence: 0.3, exclude: [], include: [] },
  fix: { limit: 10 },
  observe: { costBudget: 10, costPerTrace: 2 },
  compliance: { jurisdiction: 'EU', frameworks: ['eu-ai-act', 'gdpr'] },
};

export interface LoadedConfig {
  config: ShipReadyConfig;
  /** Non-fatal problems found while loading. */
  warnings: string[];
  path: string | null;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<LoadedConfig> {
  const path = resolve(cwd, '.shipready.yml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG, warnings: [], path: null };
  }
  return { ...parseConfig(text, path), path };
}

export function parseConfig(text: string, path = '<inline>'): Omit<LoadedConfig, 'path'> {
  const warnings: string[] = [];
  let raw: Record<string, unknown>;
  try {
    // `yaml` is already a dependency of @shipready/core; reuse it rather than
    // pulling a second parser into the CLI.
    raw = parseYamlCompat(text) as Record<string, unknown>;
  } catch (error) {
    warnings.push(`${path} is not valid YAML (${(error as Error).message}). Using defaults.`);
    return { config: DEFAULT_CONFIG, warnings };
  }
  if (!raw || typeof raw !== 'object') {
    warnings.push(`${path} is not a mapping. Using defaults.`);
    return { config: DEFAULT_CONFIG, warnings };
  }

  const config = structuredCloneish(DEFAULT_CONFIG);
  const version = number(raw.version);
  if (version !== undefined) config.version = version;
  if (version !== undefined && version > DEFAULT_CONFIG.version) {
    warnings.push(`${path} targets config version ${version}; this CLI understands ${DEFAULT_CONFIG.version}. Unknown keys are ignored.`);
  }

  // A known section that is not a mapping means the user missed a colon. Saying
  // nothing would leave them with a config that silently does nothing.
  for (const section of ['scan', 'fix', 'observe', 'compliance'] as const) {
    const value = raw[section];
    if (value !== undefined && value !== null && !record(value)) {
      warnings.push(`${path}: "${section}" must be a mapping of settings. The value was ignored.`);
      delete raw[section];
    }
  }

  const scan = record(raw.scan);
  if (scan) {
    const threshold = number(scan.threshold);
    if (threshold !== undefined) {
      if (threshold < 0 || threshold > 100) {
        warnings.push(`${path}: scan.threshold must be 0-100, got ${threshold}. Using 50.`);
      } else {
        config.scan.threshold = threshold;
      }
    }
    if (Array.isArray(scan.disable)) config.scan.disable = scan.disable.map(String);
    if (Array.isArray(scan.exclude)) config.scan.exclude = scan.exclude.map(String);
    if (Array.isArray(scan.include)) config.scan.include = scan.include.map(String);
    const confidence = number(scan.minConfidence);
    if (confidence !== undefined) {
      if (confidence < 0 || confidence > 1) {
        warnings.push(`${path}: scan.minConfidence must be 0-1, got ${confidence}. Using 0.3.`);
      } else {
        config.scan.minConfidence = confidence;
      }
    }
    if (typeof scan.minSeverity === 'string') config.scan.minSeverity = scan.minSeverity as Severity;
  }

  const fix = record(raw.fix);
  const fixLimit = number(fix?.limit);
  if (fixLimit !== undefined) config.fix.limit = Math.max(1, Math.min(50, fixLimit));

  const observe = record(raw.observe);
  const budget = number(observe?.costBudget);
  if (budget !== undefined) config.observe.costBudget = budget;
  const perTrace = number(observe?.costPerTrace);
  if (perTrace !== undefined) config.observe.costPerTrace = perTrace;

  const compliance = record(raw.compliance);
  if (typeof compliance?.jurisdiction === 'string') config.compliance.jurisdiction = compliance.jurisdiction;
  if (Array.isArray(compliance?.frameworks)) config.compliance.frameworks = compliance.frameworks.map(String);

  return { config, warnings };
}

/** Map a loaded config onto the engine's ScanConfig. */
export function toScanConfig(config: ShipReadyConfig): ScanConfig {
  const scan: ScanConfig = {
    disableRules: config.scan.disable.length > 0 ? config.scan.disable : undefined,
    minConfidence: config.scan.minConfidence,
  };
  if (config.scan.minSeverity) scan.minSeverity = config.scan.minSeverity;
  return scan;
}

/**
 * Minimal YAML subset parser.
 *
 * Handles nested maps, scalars, lists and comments -- which is all a config file
 * needs. Delegating to a real parser would mean depending on `yaml` twice (once
 * here, once in core); keeping the grammar tiny and obvious is better for a file
 * a user is expected to edit by hand.
 */
function parseYamlCompat(text: string): unknown {
  type Node = { indent: number; lines: [number, string][] };
  const lines: [number, string][] = [];
  let inBlock = false;
  let blockIndent = 0;
  let blockBuffer = '';

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\t/g, '  ');
    if (inBlock) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === '' || indent > blockIndent) {
        blockBuffer += `\n${line.slice(blockIndent)}`;
        continue;
      }
      inBlock = false;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      lines.push([index + 1, '']);
      continue;
    }
    if (trimmed === '|' || trimmed === '>') {
      inBlock = true;
      blockIndent = line.length - line.trimStart().length;
      blockBuffer = '';
      continue;
    }
    lines.push([index + 1, line]);
  }

  const node: Node = { indent: -1, lines: lines.filter(([, text]) => text !== '') };
  let cursor = 0;

  function parseBlock(indent: number): unknown {
    if (cursor >= node.lines.length) return null;
    const [, first] = node.lines[cursor]!;
    const firstIndent = first.length - first.trimStart().length;
    if (firstIndent < indent) return null;

    if (first.trimStart().startsWith('- ') || first.trim() === '-') {
      const list: unknown[] = [];
      while (cursor < node.lines.length) {
        const [, line] = node.lines[cursor]!;
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent < indent) break;
        const content = line.trimStart();
        if (!content.startsWith('-')) break;
        cursor++;
        const item = content.slice(1).trim();
        if (item === '') {
          list.push(parseBlock(lineIndent + 2));
        } else if (item.includes(':') && !item.startsWith('"')) {
          // Inline first key of a mapping item.
          const [key, ...rest] = item.split(':');
          const map: Record<string, unknown> = { [key!.trim()]: scalar(rest.join(':').trim()) };
          while (cursor < node.lines.length) {
            const [, next] = node.lines[cursor]!;
            const nextIndent = next.length - next.trimStart().length;
            if (nextIndent <= lineIndent) break;
            const parsed = parseBlock(nextIndent);
            if (parsed && typeof parsed === 'object') Object.assign(map, parsed);
            else break;
          }
          list.push(map);
        } else {
          list.push(scalar(item));
        }
      }
      return list;
    }

    const map: Record<string, unknown> = {};
    while (cursor < node.lines.length) {
      const [lineNumber, line] = node.lines[cursor]!;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) break;
      const content = line.trimStart();
      if (content.startsWith('- ')) break;
      const separator = findKeySeparator(content);
      if (separator < 0) {
        throw new Error(`line ${lineNumber}: expected "key: value"`);
      }
      const key = content.slice(0, separator).trim();
      const rest = content.slice(separator + 1).trim();
      cursor++;
      if (rest === '|' || rest === '>') {
        const parts: string[] = [];
        while (cursor < node.lines.length) {
          const [, next] = node.lines[cursor]!;
          const nextIndent = next.length - next.trimStart().length;
          if (next.trim() !== '' && nextIndent <= lineIndent) break;
          parts.push(next.trim());
          cursor++;
        }
        map[key] = parts.join(rest === '>' ? ' ' : '\n');
        continue;
      }
      map[key] = rest === '' ? (parseBlock(lineIndent + 1) ?? null) : scalar(rest);
    }
    return map;
  }

  const result = parseBlock(0);
  void blockBuffer;
  return result;
}

/** Index of the `:` that separates a key from its value, ignoring quoted text. */
function findKeySeparator(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && line[i - 1] === ' ') break;
    if (ch === ':' && (i + 1 === line.length || line[i + 1] === ' ')) return i;
  }
  return -1;
}

function scalar(raw: string): unknown {
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~' || value === '') return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => scalar(s))
      .filter((s) => s !== null);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? (value as Record<string, unknown>) : null;
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}