import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { observe, parseCommand, TraceStore } from '../src/index.js';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MOCK_AGENT = join(here, 'mock-agent.mjs');

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-observe-'));
  dbPath = join(dir, 'traces.db');
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseCommand', () => {
  it('splits a plain command', () => {
    expect(parseCommand('node app.js')).toEqual(['node', 'app.js']);
  });

  it('honours single and double quotes', () => {
    expect(parseCommand('python "my agent.py" --flag')).toEqual(['python', 'my agent.py', '--flag']);
    expect(parseCommand("python 'my agent.py'")).toEqual(['python', 'my agent.py']);
  });

  it('preserves backslashes in Windows paths', () => {
    // Treating a backslash as an escape silently turns a Windows path into
    // nonsense: C:\Users\dev\agent.js becomes C:Usersdevagent.js.
    const winPath = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'dev' + String.fromCharCode(92) + 'agent.js';
    expect(parseCommand('node ' + winPath)).toEqual(['node', winPath]);
  });

  it('collapses repeated whitespace', () => {
    expect(parseCommand('  node    app.js  ')).toEqual(['node', 'app.js']);
  });

  it('keeps an intentionally empty argument', () => {
    expect(parseCommand('cmd ""')).toEqual(['cmd', '']);
  });

  it('returns nothing for an empty string', () => {
    expect(parseCommand('')).toEqual([]);
  });

  it('rejoins an unquoted program path broken by a space', () => {
    // Regression: an install under `C:\Users\Jane Doe\` splits into two tokens
    // and the first gets spawned as a directory, so the command silently fails
    // and the real exit code is lost. A file that exists wins over whitespace.
    const dirWithSpace = join(dir, 'bin tools');
    mkdirSync(dirWithSpace, { recursive: true });
    const exe = join(dirWithSpace, 'agent-runner');
    writeFileSync(exe, 'x', 'utf8');

    expect(parseCommand(`${exe} --flag`, dir)).toEqual([exe, '--flag']);
  });

  it('resolves a relative program against the given cwd, not the process cwd', () => {
    // Regression: checking existence against our own directory would miss the
    // agent's local script and then swallow the following word into the path.
    mkdirSync(join(dir, 'my tools'), { recursive: true });
    const exe = join(dir, 'my tools', 'runner');
    writeFileSync(exe, 'x', 'utf8');

    // The token is returned as typed, not rewritten to an absolute path: the
    // command line belongs to the user. What matters is that it rejoined.
    const argv = parseCommand('./my tools/runner --flag', dir);
    expect(argv).toEqual(['./my tools/runner', '--flag']);
    expect(resolve(dir, argv[0]!)).toBe(exe);
  });

  it('leaves an ordinary command alone even when a matching file exists', () => {
    // `node app.js` where a file named `node` sits in the cwd must still split
    // on the space; rejoin only fires when a *longer* existing file is found.
    writeFileSync(join(dir, 'python'), 'x', 'utf8');
    expect(parseCommand('python agent.py', dir)).toEqual(['python', 'agent.py']);
  });

  it('does not rejoin when no longer prefix is a real file', () => {
    expect(parseCommand('C:' + String.fromCharCode(92) + 'No' + String.fromCharCode(92) + 'Such' + String.fromCharCode(92) + 'x.exe --flag', dir)).toEqual([
      'C:' + String.fromCharCode(92) + 'No' + String.fromCharCode(92) + 'Such' + String.fromCharCode(92) + 'x.exe',
      '--flag',
    ]);
  });
});

describe('observe', () => {
  it('captures a Node agent with no configuration', async () => {
    const result = await observe({
      command: `node ${MOCK_AGENT} --calls 2`,
      dbPath,
      cwd: dir,
      costBudget: 10,
    });

    expect(result.instrumented, result.reason).toBe(true);
    expect(result.trace, 'a trace should be recorded').not.toBeNull();

    const summary = result.trace!.summary;
    expect(summary.llmCalls).toBeGreaterThanOrEqual(2);
    expect(summary.toolCalls).toBeGreaterThanOrEqual(2);
    expect(summary.fileOps).toBeGreaterThanOrEqual(2);
    expect(summary.networkRequests).toBeGreaterThanOrEqual(1);
    expect(summary.decisions).toBeGreaterThanOrEqual(2);
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.costComplete).toBe(true);
    expect(summary.exitCode).toBe(0);
  }, 120_000);

  it('saves the trace to disk', async () => {
    expect(existsSync(dbPath)).toBe(true);
    const store = new TraceStore(dbPath);
    try {
      expect(store.countTraces()).toBeGreaterThan(0);
      const traces = store.listTraces();
      expect(traces[0]?.command).toContain('mock-agent');
    } finally {
      store.close();
    }
  });

  it('reports a non-Node agent honestly instead of pretending', async () => {
    // Whatever the platform is, the answer has to be "I could not instrument
    // this" -- never a fabricated trace.
    const nonNode = process.platform === 'win32' ? 'cmd.exe /c echo hi' : 'sh -c "echo hi"';
    const result = await observe({ command: nonNode, dbPath, cwd: dir });
    expect(result.instrumented).toBe(false);
    expect(result.reason).toContain('not a Node program');
    expect(result.trace).toBeNull();
  }, 60_000);

  it("propagates a non-Node program's own exit code", async () => {
    // Regression: the program name was repeated as the first argument, so
    // `sh -c "exit 0"` ran as `sh sh -c "exit 0"`, sh looked for a script named
    // `sh`, and the caller got 2 from a command that actually succeeded. Exit
    // codes are the one thing this command must never get wrong.
    const nonZero = process.platform === 'win32' ? 'cmd.exe /c exit 4' : 'sh -c "exit 4"';
    const ok = process.platform === 'win32' ? 'cmd.exe /c exit 0' : 'sh -c "exit 0"';

    const failed = await observe({ command: nonZero, dbPath, cwd: dir });
    const succeeded = await observe({ command: ok, dbPath, cwd: dir });

    expect(failed.exitCode).toBe(4);
    expect(succeeded.exitCode).toBe(0);
  }, 60_000);

  it('rejects an empty command', async () => {
    const result = await observe({ command: '   ', dbPath, cwd: dir });
    expect(result.exitCode).toBe(2);
    expect(result.trace).toBeNull();
  });

  it('reports an unparseable command', async () => {
    const result = await observe({ command: '"', dbPath, cwd: dir });
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it('propagates the child exit code', async () => {
    const result = await observe({ command: 'node -e "process.exit(3)"', dbPath, cwd: dir });
    expect(result.exitCode).toBe(3);
  }, 60_000);

  it('fires a cost-budget alert', async () => {
    const result = await observe({
      command: `node ${MOCK_AGENT} --calls 3`,
      dbPath,
      cwd: dir,
      // A budget below what three calls cost, so the alert must fire.
      costBudget: 0.00001,
    });
    const breaches = result.trace?.summary.anomalies.filter((a) => a.kind === 'cost-spike') ?? [];
    expect(breaches.length).toBeGreaterThan(0);
    expect(breaches.some((b) => b.severity === 'critical')).toBe(true);
  }, 120_000);

  it('records the agent output on stdout', async () => {
    const result = await observe({ command: `node ${MOCK_AGENT} --calls 1`, dbPath, cwd: dir });
    expect(result.stdout).toContain('mock-agent:');
  }, 120_000);

  it('caps the run with a timeout', async () => {
    const result = await observe({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      dbPath,
      cwd: dir,
      timeoutMs: 500,
    });
    expect(result.durationMs).toBeLessThan(15_000);
  }, 60_000);
});

describe('the recorded trace', () => {
  /** The trace id from the first capture, so these assertions do not depend on order. */
  let capturedId: string | undefined;

  beforeAll(async () => {
    const result = await observe({
      command: `node ${MOCK_AGENT} --calls 2`,
      dbPath,
      cwd: dir,
      costBudget: 10,
    });
    capturedId = result.trace?.summary.id;
  }, 120_000);

  it('captured a trace to inspect', () => {
    expect(capturedId).toBeTruthy();
  });

  it('identifies the hosts the agent contacted', () => {
    const store = new TraceStore(dbPath);
    try {
      const summary = store.getSummary(capturedId!)!;
      expect(summary.hosts.length).toBeGreaterThan(0);
      // Hosts only, never full URLs with query strings.
      for (const event of store.getEvents(capturedId!, { kind: 'network' })) {
        expect(JSON.stringify(event)).not.toContain('?');
      }
    } finally {
      store.close();
    }
  });

  it('distributes tool calls by name', () => {
    const store = new TraceStore(dbPath);
    try {
      const summary = store.getSummary(capturedId!)!;
      expect(Object.keys(summary.toolDistribution)).toContain('read_file');
    } finally {
      store.close();
    }
  });

  it('orders events by sequence', () => {
    const store = new TraceStore(dbPath);
    try {
      const seqs = store.getEvents(capturedId!).map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      store.close();
    }
  });

  it('never stores prompt text', () => {
    const store = new TraceStore(dbPath);
    try {
      const events = store.getEvents(capturedId!);
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain('Summarise this incident');
      }
    } finally {
      store.close();
    }
  });
});
