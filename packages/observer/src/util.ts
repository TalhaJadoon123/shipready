/** Small formatting helpers shared by the observer's renderers. */

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * USD, at a precision that matches the magnitude.
 *
 * A cost of $0.000015 rendered as "$0.00" is useless; rendered as "$0.000015" it
 * is alarming. The number of places follows the size.
 */
export function humanUsd(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value === 0) return '$0.00';
  const abs = Math.abs(value);
  if (abs < 0.0001) return `$${value.toFixed(6)}`;
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 1) return `$${value.toFixed(3)}`;
  if (abs < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/** Token counts with a thousands separator, and k/M for the large ones. */
export function tokens(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ${Math.round(seconds % 60)}s`;
  const hours = minutes / 60;
  return `${Math.floor(hours)}h ${Math.round(minutes % 60)}m`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}