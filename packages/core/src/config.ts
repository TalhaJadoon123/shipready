import type { ScanConfig } from './types.js';

/**
 * Engine defaults.
 *
 * `offline: true` by default because a scanner that phones home before it can
 * tell you about your missing rate limiter is a scanner you will turn off.
 */
export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  minConfidence: 0.3,
  offline: true,
  maxFiles: 20_000,
};

/** Default score below which CI fails. Overridable with `--threshold`. */
export const DEFAULT_CI_THRESHOLD = 50;

/** How many blockers the report surfaces by default. */
export const DEFAULT_TOP_BLOCKERS = 5;

/** How many auto-fixes `--fix` will apply in one pass. */
export const DEFAULT_FIX_LIMIT = 10;
