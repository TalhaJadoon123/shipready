import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

  it('does not store prompt text by default', async () => {
    const raw = await readFile(dbPath, 'utf8');
    expect(raw).not.toContain('Summarise this incident log');
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
  it('identifies the hosts the agent contacted', async () => {
    const store = new TraceStore(dbPath);
    try {
      const latest = store.latest();
      expect(latest).not.toBeNull();
      expect(latest!.hosts.length).toBeGreaterThan(0);
      // Only hosts, never full URLs with query strings.
      const events = store.getEvents(latest!.id, { kind: 'network' });
      for (const event of events) expect(JSON.stringify(event)).not.toContain('?');
    } finally {
      store.close();
    }
  });

  it('distributes tool calls by name', async () => {
    const store = new TraceStore(dbPath);
    try {
      const latest = store.latest();
      expect(Object.keys(latest!.toolDistribution)).toContain('read_file');
    } finally {
      store.close();
    }
  });

  it('orders events by sequence', async () => {
    const store = new TraceStore(dbPath);
    try {
      const latest = store.latest()!;
      const events = store.getEvents(latest.id);
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      store.close();
    }
  });
});
