# ShipReady

**Vibe-coded. Production-proven.**

The production-readiness layer for AI-built software. It answers one question and
then proves the answer:

> Is this ready for real users?

Six tools behind one CLI: a readiness scanner, agent observability, a compliance
documentation generator, an e-invoice validator, a GitHub Action, and a dashboard.

```bash
npx shipready scan .
#   NOT READY   42/100 (D-)   5 launch blockers
#   1. No rate limiting on API endpoints            CRITICAL  ~1 hours
#   2. No token or rate limit on LLM calls          CRITICAL  ~45 minutes
#   3. No documented backup or recovery strategy    CRITICAL  ~1 hours
```

---

## Why this exists

65% of companies now use AI coding tools. The gap between "the demo worked" and
"a hundred real users" has never been wider, and nobody checks it. A model will
happily generate an Express app with no rate limit, no error handler, and a
hardcoded API key, then declare it finished. It looks complete. It is not.

ShipReady runs 82 readiness checks across ten categories, plus 8 AI-security checks and tells you what stands between
you and real users. It works the same on human-written and AI-written code, and
it does not care which — it reads the code.

---

## Install

```bash
npm install -g @shipready/cli
# or, per project
npm install -D @shipready/cli
```

Requires Node 20.10 or newer.

---

## The six tools

### 1. Production readiness scan

82 checks across ten weighted categories: error handling, security, database,
observability, deployment, performance, data integrity, testing, accessibility,
and AI safety.

```bash
shipready scan .                          # the report
shipready scan . --format sarif -o out.sarif
shipready scan . --baseline               # fail only on a regression
shipready scan . --disable readiness/performance/no-lazy-loading
```

The score is 0–100, weighted. Blockers are findings that lose data, money or
trust; they are listed separately from quality improvements because they are the
only ones that should stop a launch.

### 2. `--fix` that generates working code

```bash
shipready fix .              # dry run: shows what it would write
shipready fix . --apply      # writes it
```

Generates ten kinds of fix: global error middleware with a request id, health and
readiness probes, `.env.example` derived from the variables your code actually
reads, a multi-stage Dockerfile, rate limiting, a validation layer, structured
logging with redaction, Sentry setup, a CI workflow, security headers, Prometheus
metrics, and smoke tests.

Every generated file is marked requires-review. Nothing is invented: no tax
rates, no document numbers, no plausible-looking placeholders.

### 3. Agent observability

```bash
shipready observe -- node my-agent.js
shipready observe report              # HTML: cost, tokens, tool heatmap
shipready observe replay              # step through what the agent did
shipready observe compare             # this run against the last one
shipready observe -- node agent.js --cost-budget 5
```

Zero configuration. It watches the three boundaries every agent crosses —
network, filesystem, process execution — and recovers model, token and cost data
from the HTTP layer without touching your code. Prompts are hashed, never stored,
unless you ask otherwise.

### 4. Compliance documentation

```bash
shipready comply init       # EU AI Act Annex IV, GDPR ROPA and DPIA, CSRD
shipready comply scan .     # personal data in code the answers never mention
```

A questionnaire ordered the way a regulator asks, where every question explains
why it is being asked. Generates technical documentation, risk management, human
oversight, post-market monitoring, declarations of conformity, records of
processing, DPIs and rights procedures — each carrying its own gap report.

### 5. E-invoice validation

```bash
shipready validate invoice.xml --fix
shipready convert invoice.xml --to csv
```

Brazil NFS-e and NF-e. CNPJ/CPF check digits, ISS tax codes, arithmetic
recomputation, duplicate detection, date ranges. `--fix` corrects what it can
prove is wrong and refuses to guess.

**Scope:** we validate and convert. We do not clear against a tax authority and
do not claim to. Clearance requires certification as a technical provider in
each jurisdiction and carries liability this tool will not take on.

### 6. CI and dashboard

```yaml
- uses: shipreadyai/shipready-action@v1
  with:
    threshold: 60
    baseline: true       # fail on regression, not on an absolute score
    sarif-output: shipready.sarif
```

The dashboard shows readiness over time, category breakdown, what to fix, agent
cost, and where compliance stands.

---

## What a score means

| Score | Verdict | What it says |
| --- | --- | --- |
| 90+ | PRODUCTION READY | No launch blockers. The rest is polish. |
| 75–89 | READY WITH CAVEATS | Blockers exist but none lose data. |
| 55–74 | NEEDS WORK | Real risk. Fix the blockers before inviting users. |
| <55 | NOT READY | Do not ship this to anyone who matters. |

A perfect 100 is deliberately hard. It means someone ran the checks, found
nothing, and knows why that is suspicious.

---

## Where the rules come from

Every finding cites the provision it maps to: EU AI Act articles, GDPR articles,
OWASP Top 10, the NIST AI RMF, ISO 27001, NIS2 Article 21, EN 16931. A readiness
score that cannot be audited is a vibe.

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm --filter @shipready/core test   # the scanning engine
```

Self-scan, which is the check the tool asks everyone else to run:

```bash
node packages/cli/bin/shipready.mjs scan . --threshold 60
```

## Licence

CLI MIT. Rule packs CC0. Dashboard proprietary.
'