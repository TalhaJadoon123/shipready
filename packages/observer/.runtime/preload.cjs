
// ShipReady observer preload. Installed by `shipready observe`.
// Patches http/https, fs and child_process to record agent behaviour.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let recorder = null;
let options = {};

async function boot() {
  const entry = process.env.SHIPREADY_OBSERVER_ENTRY;
  if (!entry) return;
  try {
    const mod = await import(pathToFileURL(entry).href);
    options = JSON.parse(process.env.SHIPREADY_OBSERVER_OPTIONS || '{}');
    mod.installRuntimeHooks({ ...options, command: process.argv.slice(2).join(' ') });
    recorder = globalThis['shipready-observe-preload'].recorder;
  } catch (error) {
    // Failing to instrument must never stop the agent from running.
    process.stderr.write(JSON.stringify({
      type: 'shipready-observer-error',
      message: error && error.message ? error.message : String(error),
    }) + '\n');
  }
}
boot();
