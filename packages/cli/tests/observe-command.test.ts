import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runObserve, runTraceCommand } from '../src/commands/observe.js';
import { TraceStore } from '@shipready/observer';
import { parseCommand } from '@shipready/observer';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-cli-observe-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A mock agent that reports through the observer bridge. */
async function agent(): Promise<string> {
  const path = join(dir, 'agent.mjs');
  await writeFile(
    path,
    [
      "const observe = globalThis.__shipreadyObserve;",
      "observe?.llm({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 300, durationMs: 800 });",
      "observe?.tool({ tool: 'read_file', args: { path: 'a.txt' }, success: true, durationMs: 12 });",
      "observe?.decision({ decision: 'answer', scores: { answer: 0.9 } });",
      "await fetch('https://api.github.com/repos/acme/agent');",
      "console.log('agent done');",
    ].join('\n'),
    'utf8',
  );
  return path;
}

describe('shipready observe', () => {
  it('runs the command and returns its exit code', async () => {
    const path = await agent();
    const code = await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });
    expect(code).toBe(0);
  }, 120_000);

  it('propagates a failing exit code', async () => {
    await writeFile(join(dir, 'bad.mjs'), 'process.exit(4);\n', 'utf8');
    const code = await runObserve({ command: `node ${join(dir, 'bad.mjs')}`, cwd: dir, quiet: true });
    expect(code).toBe(4);
  }, 120_000);

  it('rejects an empty command', async () => {
    const code = await runObserve({ command: '   ', cwd: dir, quiet: true });
    expect(code).toBe(2);
  });

  it('reports a non-Node agent without pretending to instrument it', async () => {
    const nonNode = process.platform === 'win32' ? 'cmd.exe /c exit 0' : 'sh -c "exit 0"';
    const code = await runObserve({ command: nonNode, cwd: dir, quiet: true });
    expect(code).toBe(0);
  }, 60_000);

  it('lists traces after a run', async () => {
    const path = await agent();
    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });

    // The list command reads the same database the run wrote.
    const store = new TraceStore(join(dir, '.shipready', 'traces.db'));
    try {
      expect(store.countTraces()).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }, 120_000);

  it('explains itself when there is no trace database', async () => {
    const code = await runTraceCommand({ subcommand: 'list', cwd: dir });
    expect(code).toBe(2);
  });

  it('writes an HTML report for a recorded trace', async () => {
    const path = await agent();
    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });

    const output = join(dir, 'trace.html');
    const code = await runTraceCommand({ subcommand: 'report', cwd: dir, output });
    expect(code).toBe(0);

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(output, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('gpt-4o-mini');
  }, 120_000);

  it('replays a recorded trace', async () => {
    const path = await agent();
    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });
    const code = await runTraceCommand({ subcommand: 'replay', cwd: dir });
    expect(code).toBe(0);
  }, 120_000);

  it('compares against the previous trace, or explains there is none', async () => {
    const path = await agent();
    const first = await runTraceCommand({ subcommand: 'compare', cwd: dir });
    expect(first).toBe(2);

    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });
    const only = await runTraceCommand({ subcommand: 'compare', cwd: dir });
    expect(only).toBe(2);

    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });
    const both = await runTraceCommand({ subcommand: 'compare', cwd: dir });
    expect(both).toBe(0);
  }, 180_000);

  it('summarises cost by day', async () => {
    const path = await agent();
    await runObserve({ command: `node ${path}`, cwd: dir, quiet: true });
    const code = await runTraceCommand({ subcommand: 'cost', cwd: dir });
    expect(code).toBe(0);
  }, 120_000);

  it('reports an unknown trace id rather than showing an empty trace', async () => {
    await agent();
    const code = await runTraceCommand({ subcommand: 'report', cwd: dir, traceId: 'nope' });
    expect(code).toBe(2);
  });

  it('fires a cost-budget alert', async () => {
    const path = await agent();
    await runObserve({ command: `node ${path}`, cwd: dir, costBudget: 0.00001, quiet: true });
    const store = new TraceStore(join(dir, '.shipready', 'traces.db'));
    try {
      const latest = store.latest()!;
      expect(latest.anomalies.some((a) => a.kind === 'cost-spike')).toBe(true);
    } finally {
      store.close();
    }
  }, 120_000);
});

describe('the command splitter', () => {
  it('preserves Windows paths, which is what actually gets typed', () => {
    const winPath = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'dev' + String.fromCharCode(92) + 'agent.js';
    expect(parseCommand('node ' + winPath)).toEqual(['node', winPath]);
  });

  it('honours quotes around a path with spaces', () => {
    expect(parseCommand('node "C:/my agent/run.js"')).toEqual(['node', 'C:/my agent/run.js']);
  });
});