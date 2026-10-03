# @shipready/observer

Observability for AI agents. Run any command under observation and get back
what it cost, what it called, and what it did while it was thinking.

```bash
shipready observe -- node my-agent.js
#   4.2 minutes · $0.0831 · 71k in / 18k out · 23 model calls · 47 tool calls
```

## Why this is a separate package

Two reasons.

**It runs a native dependency.** `better-sqlite3` compiles against your Node
version. Installing this package on a machine without a toolchain will fail, and
that should not stop you using the scanner. `@shipready/cli` depends on it, so if
you only scan, install with `--ignore-scripts` and `observe` stays unavailable
rather than breaking the install.

**The observer is not a linter.** It patches the boundaries an agent crosses —
model calls, tool calls, network — and that means it wraps the process. Most
people never run it.

## Traces

Stored in `.shipready/traces.db` on your machine, in SQLite. Nothing leaves your
filesystem unless you explicitly upload a summary to the dashboard.

```bash
shipready observe list                  # recorded runs
shipready observe cost                  # spend by day across runs
shipready observe replay <id>           # step through what the agent did
shipready observe report <id>           # HTML report with cost/activity charts
shipready observe compare <id>          # this run against the one before it
```

Global flags on `observe` itself:

| | |
|---|---|
| `--cost-budget <usd>` | alert when a trace crosses this cost |
| `--max-cost <usd>` | alert on any single call above it |
| `--timeout <ms>` | stop observing after this long |
| `--capture-content` | store prompt/response text (hashed by default) |
| `--db <path>` | trace database location |
| `--json` | emit the trace summary as JSON |

## Cost

Model pricing is built in, and the cost is attributed per model, per call, from
the response itself rather than estimated from token counts. If a provider is
not in the table, that call is recorded with `costComplete: false` rather than
being quietly priced at zero — a cost report that silently under-counts is
worse than one that says it does not know.

## How it works

A preload script patches `fetch`, `http` and the Anthropic/OpenAI SDKs at the
synchronous boundary, then writes events to the local database. It is checked in
as CommonJS rather than generated, because a fast-failing agent can call
`process.exit(1)` before an async dynamic import resolves — in ESM those traces
are lost, which is exactly the one you most want to see.

## Licence

MIT.