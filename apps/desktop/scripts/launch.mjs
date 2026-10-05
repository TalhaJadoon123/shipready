/**
 * ShipReady desktop launcher.
 *
 * Starts the dashboard and opens it in the default browser. This is a launcher,
 * not an Electron shell, and the distinction matters: it adds no 200 MB
 * dependency, it works on every platform Node runs on, and the UI it shows is
 * the same server-rendered dashboard rather than a second implementation that
 * drifts.
 *
 * What it does:
 *   1. builds the dashboard if it is not built
 *   2. seeds demo data on first run, so there is something to look at
 *   3. waits for the server to answer rather than guessing
 *   4. opens the browser
 *
 * Usage:
 *   node apps/desktop/scripts/launch.mjs           # launch
 *   node apps/desktop/scripts/launch.mjs --port 4000
 *   node apps/desktop/scripts/launch.mjs --no-open # do not open a browser
 *   node apps/desktop/scripts/launch.mjs --reset   # wipe demo data first
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const web = join(repo, 'packages', 'web');
const snapshot = join(web, '.shipready', 'dashboard.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(opt('port', process.env.SHIPREADY_PORT ?? 3001));
const OPEN = !flag('no-open');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function run(command, commandArgs, cwd, label) {
  process.stdout.write(`${dim(label)} `);
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.log(red('failed'));
    process.exit(result.status ?? 1);
  }
  console.log(green('done'));
}

if (!existsSync(join(repo, 'pnpm-lock.yaml'))) {
  console.error(red('This launcher must run from inside the ShipReady repository.'));
  process.exit(1);
}

console.log(`\n${bold('ShipReady')} ${dim('desktop')}\n`);

if (flag('reset')) {
  if (existsSync(snapshot)) {
    const { rmSync } = await import('node:fs');
    rmSync(snapshot, { force: true });
    console.log(dim('removed demo snapshot'));
  }
}

// Build only when needed. `next build` is slow and pointless if the output is
// already there, and "rebuild every launch" is the fastest way to make people
// stop using a launcher.
if (!existsSync(join(web, '.next', 'BUILD_ID'))) {
  console.log(dim('dashboard not built yet, building once (this takes a minute)'));
  run('pnpm', ['--filter', '@shipready/web', 'build'], repo, 'build');
} else {
  console.log(dim('dashboard already built'));
}

// Demo data, so the first launch shows a verdict and a trend rather than an
// empty page telling the user to run a seed command.
if (!existsSync(snapshot)) {
  console.log(dim('no demo data yet, seeding'));
  const seed = spawnSync('pnpm', ['--filter', '@shipready/web', 'seed'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
  if (seed.status !== 0) {
    console.log(red('seed failed -- the dashboard will still open, just empty'));
  }
} else {
  console.log(dim('demo data present'));
}

console.log(`\n${dim('starting dashboard on port')} ${PORT} ...\n`);

// Invoke Next directly rather than through `pnpm --filter ... start`.
//
// The web package's start script hardcodes `--port 3001`, which overrides the
// PORT environment variable, so the launcher initially polled a port nothing was
// listening on. And pnpm does not forward extra arguments to a filtered script:
// it appends them literally, producing `next start --port 3001 "--" "--port"
// "3011"`, which fails outright.
//
// `next start` also sets NODE_ENV=production, and in production the store
// demands a real database:
//
//     Error: DATABASE_URL is required when SHIPREADY_DATABASE is postgres
//
// A local launcher has no Postgres, so the driver is pinned to the file-backed
// store. Without this every route 500s and the dashboard looks broken.
const child = spawn(process.execPath, [join(web, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(PORT)], {
  cwd: web,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(PORT),
    SHIPREADY_DATABASE: 'memory',
    SHIPREADY_MEMORY_PATH: snapshot,
  },
});

const url = `http://localhost:${PORT}`;

// Poll rather than sleep a fixed amount. Next.js prints "Ready" when it is
// ready, but reading its output to find that is brittle; asking the server is
// the honest check.
const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.log(red(`\ndashboard exited with code ${child.exitCode}`));
    process.exit(child.exitCode ?? 1);
  }
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    // Not up yet. Keep waiting.
  }
  await new Promise((r) => setTimeout(r, 700));
}

if (!ready) {
  console.log(red(`\ndid not answer within 90s. Open ${url} manually once it starts.`));
} else {
  console.log(`\n${green('ready')}  ${bold(url)}\n`);
  if (OPEN) {
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
      process.platform === 'darwin' ? ['open', [url]] :
      ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
  } else {
    console.log(dim('browser not opened (--no-open)'));
  }
}

const stop = () => {
  console.log(dim('\nshutting down'));
  child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));