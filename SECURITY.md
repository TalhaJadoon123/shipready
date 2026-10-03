# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Report it privately
to <security@shipready.ai>. Include the affected version, a description of the
issue, and reproduction steps if you have them.

You can expect an acknowledgement within 3 business days and a substantive
response within 10. If a fix is warranted we will agree a disclosure timeline
with you, and we will credit you in the release notes unless you would rather
we did not.

## What counts as a vulnerability

ShipReady reads source code. So the interesting attack surface is: **can
untrusted input make ShipReady do something it should not?**

In scope:

- **Path traversal in scanning.** `shipready scan <path>` accepting a path
  outside the intended root, or a symlink that resolves outside it.
- **Code execution via a crafted repository.** ShipReady must never execute code
  from the repository it is scanning. `loadConfig()` reads configuration; it
  must never evaluate it. The observer *does* execute the agent you point it at,
  which is its purpose, but it must never execute anything from a trace file or
  a stored report.
- **Untrusted reports.** `shipready report`, SARIF upload and the dashboard API
  all accept JSON produced elsewhere. A crafted report must not be able to write
  files, execute code, or inject into the generated HTML report.
- **The generated HTML report.** It is opened in a browser, so any unescaped
  finding content is a stored-XSS vector against whoever reads the report.
- **Supply chain.** Anything that could execute during `npm install -g
  @shipready/cli`, including install scripts in `@shipready/observer`
  (`better-sqlite3` builds native code).
- **Credential exposure.** ShipReady must not write tokens, API keys or
  environment secrets into a saved report, a trace, or a dashboard record.

Out of scope:

- **False positives and false negatives in rules.** These are quality bugs, not
  vulnerabilities. Report them as issues.
- **Reports that describe a real problem in the scanned code.** That is the
  product working.
- **Running ShipReady against code you are not authorised to read.**

## Trust boundaries

For anyone auditing this, these are the boundaries the design relies on.

**The scanner never executes the code it scans.** It reads bytes, strips
comments, and matches patterns. If you find a path from a scanned file to
`eval`, `Function`, `child_process`, or a dynamic `import()`, that is a bug worth
reporting regardless of how contrived the input.

**Compliance documents never leave your filesystem.** `shipready comply
generate` writes files. It does not upload them. The dashboard stores a *version
record* -- company, frameworks, score, gap list -- and never the documents
themselves, because a regulatory document about your business is not ours to
keep. If you find document contents being sent anywhere, that is a bug.

**Traces stay local.** The observer writes to `.shipready/traces.db` on your
machine. Uploading a trace summary to the dashboard is an explicit action, and
the summary is totals, not event payloads.

**The dashboard has no authentication yet.** Do not deploy it publicly. This is
tracked and called out in the README and the investor materials; it is not a
hidden limitation.

## Scanning a malicious repository safely

`shipready scan` is safe against a hostile repository. Two things to be aware
of:

- **`shipready observe -- <command>` executes `<command>`.** Point it at code
  you trust.
- **`shipready fix --apply` writes files** into the scanned tree. Always run
  `shipready fix --dry-run` first, and only apply in a clean git working tree.

## Supported versions

ShipReady is pre-1.0. Only the latest published version receives fixes.