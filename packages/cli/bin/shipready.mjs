#!/usr/bin/env node
/**
 * ShipReady CLI entry point.
 *
 * Kept deliberately thin: it installs an unhandled-rejection handler that
 * prints something actionable rather than a bare stack trace, and defers
 * everything else to `main`. Nothing runs above the dynamic import, so
 * requiring this file has no side effects.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { main } = await import(pathToFileURL(join(here, '..', 'dist', 'program.js')).href);

process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(
    `\nshipready: unhandled rejection: ${detail}\n\n` +
      'This is a bug. Please report it: https://github.com/shipreadyai/shipready/issues\n',
  );
  process.exitCode = 2;
});

const code = await main();

process.exitCode = code;