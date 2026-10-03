import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceRecorder } from '../src/recorder.js';
import { TraceStore } from '../src/store.js';
import { estimateCost, estimateTokens, lookupModel, MODEL_PRICES } from '../src/pricing.js';
import { diffTraces } from '../src/diff.js';
import { renderTraceReport } from '../src/html.js';
import { preview, redactSecrets } from '../src/types.js';
import type { Trace, TraceEvent } from '../src/types.js';

/**
 * A mock agent that makes LLM calls, tool calls, file and network activity.
 * This is the shape of the thing the observer exists to describe, so the tests
 * build one rather than mocking the recorder's own inputs.
 */
function mockAgent(recorder: TraceRecorder): TraceRecorder {
  recorder.llm({
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt: 'Summarise this incident report for the on-call engineer.',
    response: 'Three requests failed with a 500 between 14:02 and 14:07 UTC.',
    inputTokens: 1_240,
    outputTokens: 380,
    durationMs: 1_850,
  });
  recorder.tool({
    tool: 'read_file',
    args: { path: 'logs/incident-2026-01-02.log', maxBytes: 65_536 },
    result: '2 048 lines',
    success: true,
    durationMs: 34,
  });
  recorder.network({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/agent/issues/42',
    status: 200,
    responseBytes: 8_120,
    durationMs: 210,
  });
  recorder.llm({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    prompt: 'Draft a post-incident summary.',
    response: 'Root cause: a token quota was never configured.',
    inputTokens: 2_100,
    outputTokens: 900,
    durationMs: 3_400,
  });
  recorder.tool({
    tool: 'create_issue',
    args: { title: 'Token quota was never configured' },
    success: false,
    durationMs: 1_900,
    error: 'HTTP 429 rate limited',
  });
  recorder.decision({
    decision: 'file an issue',
    reasoning: 'The quota gap will recur; it needs a ticket, not a memory.',
    scores: { file_issue: 0.82, retry: 0.11, escalate: 0.07 },
  });
  recorder.network({
    method: 'POST',
    url: 'https://api.github.com/repos/acme/agent/issues',
    status: 429,
    durationMs: 1_900,
    error: 'rate limited',
  });
  recorder.file({ path: 'notes/postmortem.md', operation: 'write', bytes: 4_120 });
  recorder.error({ message: 'Anomaly: observed cost exceeded the configured budget', fatal: false });
  return recorder;
}

let dir: string;
let dbPath: string;
let trace: Trace;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shipready-observer-'));
  dbPath = join(dir, 'traces.db');
  const recorder = new TraceRecorder('node mock-agent.js', { dbPath, costBudget: 0.05, cwd: dir }, dir);
  mockAgent(recorder);
  trace = recorder.end(0);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pricing', () => {
  it('resolves a bare model name', () => {
    expect(lookupModel('gpt-4o-mini')?.id).toBe('openai/gpt-4o-mini');
    expect(lookupModel('claude-sonnet-4')?.id).toBe('anthropic/claude-sonnet-4');
  });

  it('resolves a provider-prefixed name', () => {
    expect(lookupModel('openai/gpt-4o')?.provider).toBe('openai');
  });

  it('resolves a dated snapshot back to the alias', () => {
    expect(lookupModel('gpt-4o-2024-11-20')?.id).toBe('openai/gpt-4o');
  });

  it('resolves a Bedrock-style model id', () => {
    expect(lookupModel('anthropic.claude-3-5-sonnet-20240620-v1:0')?.provider).toBe('anthropic');
  });

  it('returns undefined rather than guessing', () => {
    expect(lookupModel('totally-made-up-model')).toBeUndefined();
    expect(lookupModel('')).toBeUndefined();
  });

  it('prices a call correctly', () => {
    // gpt-4o-mini: $0.15/M input, $0.60/M output.
    const cost = estimateCost('gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost.priced).toBe(true);
    expect(cost.usd).toBeCloseTo(0.75, 6);
  });

  it('applies the cached-input rate', () => {
    const withCache = estimateCost('gpt-4o-mini', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(withCache.usd).toBeCloseTo(0.075, 6);
  });

  it('marks an unknown model as unpriced rather than free', () => {
    const cost = estimateCost('mystery-model', { inputTokens: 1_000, outputTokens: 500 });
    expect(cost.priced).toBe(false);
    expect(cost.usd).toBe(0);
  });

  it('prices a local model at zero but as priced', () => {
    const cost = estimateCost('llama3.1', { inputTokens: 100_000, outputTokens: 100_000 });
    expect(cost.usd).toBe(0);
    expect(cost.priced).toBe(true);
  });

  it('estimates tokens conservatively', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });

  it('has no duplicate model ids', () => {
    const ids = MODEL_PRICES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has plausible prices on every entry', () => {
    for (const model of MODEL_PRICES) {
      expect(model.inputPerMillion, model.id).toBeGreaterThanOrEqual(0);
      expect(model.outputPerMillion, model.id).toBeGreaterThanOrEqual(0);
      if (!model.free) expect(model.inputPerMillion, model.id).toBeGreaterThan(0);
    }
  });
});

describe('TraceRecorder', () => {
  it('records every kind of event', () => {
    const kinds = new Set(trace.events.map((e) => e.kind));
    expect(kinds.has('llm')).toBe(true);
    expect(kinds.has('tool')).toBe(true);
    expect(kinds.has('file')).toBe(true);
    expect(kinds.has('network')).toBe(true);
    expect(kinds.has('decision')).toBe(true);
    expect(kinds.has('error')).toBe(true);
    expect(kinds.has('session')).toBe(true);
  });

  it('aggregates the summary', () => {
    const s = trace.summary;
    expect(s.llmCalls).toBe(2);
    expect(s.toolCalls).toBe(2);
    expect(s.networkRequests).toBe(2);
    expect(s.fileOps).toBe(1);
    expect(s.decisions).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.totalInputTokens).toBe(3_340);
    expect(s.totalOutputTokens).toBe(1_280);
  });

  it('computes a cost and marks it complete', () => {
    expect(trace.summary.totalCostUsd).toBeGreaterThan(0);
    expect(trace.summary.costComplete).toBe(true);
  });

  it('breaks the cost down by model', () => {
    expect(Object.keys(trace.summary.byModel).sort()).toEqual(['claude-sonnet-4', 'gpt-4o-mini']);
  });

  it('distributes tool calls', () => {
    expect(trace.summary.toolDistribution['read_file']).toBe(1);
    expect(trace.summary.toolDistribution['create_issue']).toBe(1);
  });

  it('records hosts, not full URLs', () => {
    expect(trace.summary.hosts).toContain('api.github.com');
    const networkEvents = trace.events.filter((e) => e.kind === 'network');
    for (const event of networkEvents) {
      expect(JSON.stringify(event)).not.toContain('repos/acme/agent');
    }
  });

  it('hashes prompts rather than storing them', () => {
    const llm = trace.events.find((e) => e.kind === 'llm') as Extract<TraceEvent, { kind: 'llm' }>;
    expect(llm.promptHash).toMatch(/^[0-9a-f]{32}$/);
    expect(llm.data.prompt).toBeUndefined();
    expect(JSON.stringify(trace)).not.toContain('Summarise this incident');
  });

  it('stores prompts when asked to capture content', () => {
    const recorder = new TraceRecorder('t', { dbPath, captureContent: true }, dir);
    recorder.llm({
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt: 'visible now',
      response: 'also visible',
      inputTokens: 10,
      outputTokens: 5,
    });
    const traceWithContent = recorder.end(0);
    expect(JSON.stringify(traceWithContent)).toContain('visible now');
  });

  it('assigns sequential event ids', () => {
    const seqs = trace.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('is deterministic for identical input', () => {
    // Same trace id, so the derived event ids are comparable run to run.
    const options = { dbPath, costBudget: 0, traceId: 'fixed-for-determinism' };
    const a = new TraceRecorder('t', options, dir);
    mockAgent(a);
    const first = a.end(0);
    const b = new TraceRecorder('t', options, dir);
    mockAgent(b);
    const second = b.end(0);
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.summary.totalCostUsd).toBe(first.summary.totalCostUsd);
  });

  it('flags a cost budget breach exactly once', () => {
    const recorder = new TraceRecorder('t', { dbPath, costBudget: 0.0001 }, dir);
    recorder.llm({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 });
    recorder.llm({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 });
    recorder.llm({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 });
    const breaches = recorder.summary().anomalies.filter((a) => a.kind === 'cost-spike');
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('critical');
  });

  it('flags an unknown model as unpriced', () => {
    const recorder = new TraceRecorder('t', { dbPath }, dir);
    recorder.llm({ provider: 'x', model: 'who-knows', inputTokens: 100, outputTokens: 100 });
    const summary = recorder.summary();
    expect(summary.costComplete).toBe(false);
    expect(summary.anomalies.some((a) => a.kind === 'unpriced-model')).toBe(true);
  });

  it('flags a large file payload', () => {
    const recorder = new TraceRecorder('t', { dbPath }, dir);
    recorder.file({ path: 'huge.bin', operation: 'read', bytes: 9_000_000 });
    expect(recorder.summary().anomalies.some((a) => a.kind === 'large-payload')).toBe(true);
  });

  it('is idempotent on end', () => {
    const recorder = new TraceRecorder('t', { dbPath }, dir);
    const first = recorder.end(1);
    const second = recorder.end(2);
    expect(first.events.length).toBe(second.events.length);
    expect(second.summary.exitCode).toBe(1);
  });

  it('redacts secrets in tool arguments', () => {
    const recorder = new TraceRecorder('t', { dbPath, captureContent: true }, dir);
    recorder.tool({ tool: 'call', args: { apiKey: 'sk-live-123', safe: 'value' }, success: true });
    const serialised = JSON.stringify(recorder.end(0));
    expect(serialised).not.toContain('sk-live-123');
    expect(serialised).toContain('[REDACTED]');
  });
});

describe('TraceStore', () => {
  it('round-trips a trace', () => {
    const store = new TraceStore(dbPath);
    try {
      store.save(trace);
      const loaded = store.getTrace(trace.summary.id);
      expect(loaded?.summary.id).toBe(trace.summary.id);
      expect(loaded?.events.length).toBe(trace.events.length);
      expect(loaded?.summary.totalCostUsd).toBeCloseTo(trace.summary.totalCostUsd, 6);
    } finally {
      store.close();
    }
  });

  it('lists traces newest first', () => {
    const store = new TraceStore(dbPath);
    try {
      expect(store.countTraces()).toBeGreaterThan(0);
      const listed = store.listTraces();
      const newest = listed[0]?.startedAt ?? '';
    const oldest = listed[listed.length - 1]?.startedAt ?? '';
    expect(newest >= oldest).toBe(true);
    } finally {
      store.close();
    }
  });

  it('finds the previous trace', () => {
    const store = new TraceStore(dbPath);
    try {
      store.save(trace);
      const later: Trace = {
        ...trace,
        summary: { ...trace.summary, id: 'later-trace', startedAt: '2099-01-01T00:00:00.000Z' },
      };
      store.save(later);
      expect(store.previous('later-trace')?.id).toBe(trace.summary.id);
    } finally {
      store.close();
    }
  });

  it('filters events by kind', () => {
    const store = new TraceStore(dbPath);
    try {
      store.save(trace);
      const llm = store.getEvents(trace.summary.id, { kind: 'llm' });
      expect(llm).toHaveLength(2);
      expect(llm.every((e) => e.kind === 'llm')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('returns null for an unknown trace', () => {
    const store = new TraceStore(dbPath);
    try {
      expect(store.getTrace('does-not-exist')).toBeNull();
      expect(store.getSummary('does-not-exist')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('aggregates cost by day', () => {
    const store = new TraceStore(dbPath);
    try {
      store.save(trace);
      const byDay = store.costByDay();
      expect(Array.isArray(byDay)).toBe(true);
      expect(byDay.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('deletes a trace', () => {
    const store = new TraceStore(dbPath);
    try {
      store.save(trace);
      expect(store.deleteTrace(trace.summary.id)).toBe(true);
      expect(store.getTrace(trace.summary.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('creates the database file if absent', () => {
    const fresh = join(dir, 'nested', 'deeper', 'fresh.db');
    const store = new TraceStore(fresh);
    try {
      expect(store.countTraces()).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('diffTraces', () => {
  function synthetic(overrides: Partial<Trace['summary']>, events: TraceEvent[]): Trace {
    return { version: 1, events, summary: { ...baseSummary(), ...overrides } };
  }

  function baseSummary(): Trace['summary'] {
    return {
      id: 'base',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10_000,
      command: 'node agent.js',
      cwd: '/tmp',
      totalCostUsd: 0.1,
      costComplete: true,
      totalInputTokens: 1_000,
      totalOutputTokens: 500,
      totalCachedTokens: 0,
      llmCalls: 2,
      toolCalls: 3,
      fileOps: 1,
      networkRequests: 2,
      decisions: 0,
      errors: 0,
      toolDistribution: { read_file: 3 },
      byModel: { 'openai/gpt-4o-mini': { calls: 2, inputTokens: 1_000, outputTokens: 500, costUsd: 0.1, priced: true } },
      hosts: ['api.github.com'],
      anomalies: [],
    };
  }

  it('reports an identical trace as unchanged', () => {
    const diff = diffTraces(synthetic({}, []), synthetic({}, []));
    expect(diff.scorecard.every((m) => m.delta === 0)).toBe(true);
    expect(diff.headline).toContain('No behavioural change');
    expect(diff.advice).toHaveLength(0);
  });

  it('reports a cost regression with advice', () => {
    const diff = diffTraces(
      synthetic({ totalCostUsd: 0.1 }, []),
      synthetic({ totalCostUsd: 0.5 }, []),
    );
    const cost = diff.scorecard.find((m) => m.metric === 'Total cost (USD)')!;
    expect(cost.delta).toBeCloseTo(0.4, 6);
    expect(cost.worse).toBe(true);
    expect(diff.headline).toContain('cost rose');
    expect(diff.advice.some((a) => a.includes('Cost rose'))).toBe(true);
  });

  it('reports a cost improvement', () => {
    const diff = diffTraces(
      synthetic({ totalCostUsd: 0.5 }, []),
      synthetic({ totalCostUsd: 0.1 }, []),
    );
    expect(diff.headline).toContain('cost fell');
    expect(diff.scorecard.find((m) => m.metric === 'Total cost (USD)')!.worse).toBe(false);
  });

  it('reports new hosts', () => {
    const diff = diffTraces(
      synthetic({ hosts: ['api.github.com'] }, []),
      synthetic({ hosts: ['api.github.com', 'paste.example.com'] }, []),
    );
    expect(diff.newHosts).toEqual(['paste.example.com']);
    expect(diff.headline).toContain('new host');
    expect(diff.advice.some((a) => a.includes('paste.example.com'))).toBe(true);
  });

  it('reports a new tool as appearing', () => {
    const diff = diffTraces(
      synthetic({ toolDistribution: { read_file: 3 } }, []),
      synthetic({ toolDistribution: { read_file: 3, exec_bash: 1 } }, []),
    );
    expect(diff.toolChanges.some((c) => c.name === 'exec_bash' && c.before === 0 && c.after === 1)).toBe(true);
  });

  it('reports new and resolved anomalies', () => {
    const diff = diffTraces(
      synthetic({ anomalies: [{ kind: 'cost-spike', severity: 'warning', message: 'old', ts: '2026-01-01T00:00:00.000Z' }] }, []),
      synthetic({ anomalies: [{ kind: 'unusual-host', severity: 'info', message: 'new', ts: '2026-01-01T00:00:00.000Z' }] }, []),
    );
    expect(diff.newAnomalies).toEqual(['new']);
    expect(diff.resolvedAnomalies).toEqual(['old']);
  });

  it('notes when the prompt changed', () => {
    const before = synthetic({}, [
      { id: 'a', seq: 0, kind: 'llm', ts: 'x', offsetMs: 0, name: 'm', data: {}, provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, costUsd: 0, costPriced: true, promptHash: 'aaa', responseHash: 'aaa' },
    ]);
    const after = synthetic({}, [
      { id: 'b', seq: 0, kind: 'llm', ts: 'x', offsetMs: 0, name: 'm', data: {}, provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, costUsd: 0, costPriced: true, promptHash: 'bbb', responseHash: 'aaa' },
    ]);
    const diff = diffTraces(before, after);
    expect(diff.advice.some((a) => a.includes('prompt changed'))).toBe(true);
  });
});

describe('renderTraceReport', () => {
  // Rendered lazily: `beforeAll` populates `trace`, and a describe-body call
  // would run before it.
  const render = (): string => renderTraceReport(trace);

  it('is a complete offline document', () => {
    const html = render();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/<script\s+src=/i);
  });

  it('shows cost and token totals', () => {
    const html = render();
    expect(html).toContain('Total cost');
    expect(html).toContain('Input tokens');
    expect(html).toContain('Output tokens');
  });

  it('lists every model', () => {
    const html = render();
    expect(html).toContain('gpt-4o-mini');
    expect(html).toContain('claude-sonnet-4');
  });

  it('shows the anomalies', () => {
    expect(render()).toContain('Anomalies');
  });

  it('escapes content', () => {
    const nasty: Trace = {
      ...trace,
      events: trace.events.map((e, i) =>
        i === 0 ? { ...e, name: '<script>alert(1)</script>' } : e,
      ),
    };
    expect(renderTraceReport(nasty)).not.toContain('<script>alert(1)</script>');
  });
});

describe('helpers', () => {
  it('redacts secret-looking keys at any depth', () => {
    const redacted = redactSecrets({
      safe: 'value',
      apiKey: 'sk-123',
      nested: { authorization: 'Bearer x', token: 'y', keep: 'z' },
    }) as Record<string, Record<string, unknown>>;
    expect(redacted['safe']).toBe('value');
    expect(redacted['apiKey']).toBe('[REDACTED]');
    expect(redacted['nested']!['authorization']).toBe('[REDACTED]');
    expect(redacted['nested']!['keep']).toBe('z');
  });

  it('truncates previews and marks them', () => {
    const long = 'x'.repeat(500);
    const result = preview(long, 100);
    expect(result).toContain('… (500 chars)');
    expect(result.length).toBeLessThan(140);
  });
});