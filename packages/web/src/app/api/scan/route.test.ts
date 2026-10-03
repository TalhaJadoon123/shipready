import { describe, expect, it } from 'vitest';
import { isScannablePath } from './route.js';

/**
 * Path guard tests.
 *
 * The dashboard can scan only inside its own root. This is the one check
 * standing between an authenticated user and arbitrary filesystem read, so it
 * is tested adversarially rather than hopefully.
 */
describe('isScannablePath', () => {
  it('accepts a relative path', () => {
    expect(isScannablePath('src')).toBe(true);
    expect(isScannablePath('packages/core')).toBe(true);
    expect(isScannablePath('a/b/c')).toBe(true);
  });

  it('rejects traversal', () => {
    expect(isScannablePath('..')).toBe(false);
    expect(isScannablePath('../etc')).toBe(false);
    expect(isScannablePath('src/../../etc/passwd')).toBe(false);
    expect(isScannablePath('src/..')).toBe(false);
  });

  it('rejects absolute paths on both platforms', () => {
    expect(isScannablePath('/etc/passwd')).toBe(false);
    expect(isScannablePath('C:\\Windows')).toBe(false);
    expect(isScannablePath('\\\\server\\share')).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(isScannablePath('')).toBe(false);
  });

  it('accepts a filename containing dots that is not traversal', () => {
    expect(isScannablePath('src/app.config.ts')).toBe(true);
    expect(isScannablePath('a..b/c')).toBe(true);
  });

  it('rejects mixed separators in a traversal', () => {
    expect(isScannablePath('src/..\\..\\etc')).toBe(false);
    expect(isScannablePath('..\\windows')).toBe(false);
  });
});