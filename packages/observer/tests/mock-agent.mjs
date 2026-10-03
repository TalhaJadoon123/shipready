/**
 * A mock agent that exercises every instrumented boundary.
 *
 * This is the thing `shipready observe` exists to describe, so the tests use a
 * real one rather than mocking the recorder's inputs. It makes an LLM call, a
 * tool call, file I/O and a network request, which is the minimum for a trace
 * to be worth looking at.
 *
 * Usage: `node mock-agent.mjs [--calls N]`
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const calls = Number(args[args.indexOf('--calls') + 1] ?? 3) || 3;

const TRACE_ID = process.env.SHIPREADY_TRACE_ID ?? `mock-${process.pid}`;

/**
 * The bridge the preload installs.
 *
 * Using it means model calls and decisions are reported with exact token
 * counts and reasoning hashes, which zero-config capture cannot recover from
 * the network boundary.
 */
const observe = globalThis.__shipreadyObserve;

/** A model call, with the token counts a real provider would return. */
async function callModel(prompt) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const response = `Summary of ${inputTokens} tokens: the incident was a missing token quota.`;
  const outputTokens = Math.ceil(response.length / 4);

  observe?.llm({
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt,
    response,
    inputTokens,
    outputTokens,
    durationMs: 400 + Math.round(Math.random() * 600),
  });
  return response;
}

/** A tool call that reads a file. */
function readTool(path) {
  const started = Date.now();
  try {
    const content = readFileSync(path, 'utf8');
    observe?.tool({
      tool: 'read_file',
      args: { path },
      result: `${content.length} bytes`,
      success: true,
      durationMs: Date.now() - started,
    });
    return content;
  } catch (error) {
    observe?.tool({ tool: 'read_file', args: { path }, success: false, durationMs: Date.now() - started, error: String(error) });
    throw error;
  }
}

/** An outbound request, recorded as a network event. */
async function httpRequest(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET' });
    const body = await res.text();
    observe?.network?.({ method: 'GET', url, status: res.status, responseBytes: body.length, durationMs: Date.now() - started });
    return res.status;
  } catch (error) {
    observe?.network?.({ method: 'GET', url, durationMs: Date.now() - started, error: String(error) });
    throw error;
  }
}

async function main() {
  const work = join(process.cwd(), '.shipready-mock');
  mkdirSync(work, { recursive: true });
  const logPath = join(work, 'incident.log');
  writeFileSync(logPath, 'ERROR: token quota missing\n'.repeat(20), 'utf8');


  const results = [];

  for (let i = 0; i < calls; i++) {
    const log = readTool(logPath);
    const summary = await callModel(`Summarise this incident log for run ${i}:\n${log.slice(0, 200)}`);

    observe?.decision({
      decision: 'open a ticket',
      reasoning: 'The quota gap will recur; it needs tracking rather than a memory.',
      scores: { open_ticket: 0.81, retry: 0.12, escalate: 0.07 },
    });

    results.push(summary);
  }

  // A network call the observer should flag: an unfamiliar host.
  try {
    await httpRequest('https://api.github.com/repos/acme/agent/issues/42');
  } catch {
    // Offline is fine; the trace still records the attempt.
  }

  observe?.error({ message: 'Anomaly: cost exceeded the configured budget', fatal: false });

  const out = join(work, 'postmortem.md');
  writeFileSync(out, `# Postmortem ${TRACE_ID}\n\n${results.join('\n\n')}\n`, 'utf8');


  process.stdout.write(`mock-agent: ${calls} model calls, ${results.length} summaries\n`);
  process.stdout.write(`mock-agent: wrote ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`mock-agent failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
