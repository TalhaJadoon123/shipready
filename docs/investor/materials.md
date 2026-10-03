# ShipReady — Investor Materials

Everything here is grounded in the repository. Every number marked **[verified]**
was produced by running the tool in this codebase; every number marked
**[UNVERIFIED]** is a placeholder you must replace before showing an investor.

Nothing here is published. It is a working document for you to edit, argue with,
and cut down to the ten minutes you actually get.

---

## 1. The one-paragraph pitch

> AI coding tools made writing code 10x faster. They did not make *shipping*
> code faster. A model will happily generate an Express app with no rate limit,
> no error handler and a hardcoded API key, then say it's finished — because from
> the model's point of view it *is* finished. ShipReady is the layer that answers
> the only question that matters next: **what stands between this codebase and a
> hundred real users?** It runs 90 checks, returns a single weighted score, and
> tells you the specific things that would lose you data, money or trust —
> before your users find them.

---

## 2. The demo (this is what actually closes deals)

Run these live. The tool is the proof; a slide deck is a promise.

```bash
# 1. The hook. Scan something real and hostile.
npx shipready scan . --no-color
#    -> NOT READY  62/100 (D+)  9 launch blockers, 32 findings

# 2. Show that it is not a toy: point it at a mature OSS codebase.
npx shipready scan ~/code/some-real-repo
#    -> every finding has a file, a line, a reason, and a fix

# 3. The money shot: it tells you what it would take to be shippable.
npx shipready scan . --format json | jq '.summary.estimatedTimeToLaunch'
#    -> "about 6.6 hours"  (not "you have problems")

# 4. Show the fix, not just the finding.
npx shipready fix . --dry-run

# 5. The CI gate. This is how it becomes a habit, not a demo.
npx shipready check . --threshold 70
#    -> exit 1, blocks the merge
```

Then show the dashboard (`pnpm --filter @shipready/web seed && ... dev`) for
the trend, agent cost and compliance panels.

**Timing:** the scan of a 65k-line repo takes ~2 minutes. On a small repo it's
seconds. Do the small one live; keep the big one as a prepared screenshot.

---

## 3. Facts you can state without hedging

All **[verified]** by running the tool here. Nothing inferred.

| Claim | Number | How to check |
|---|---|---|
| Rules implemented | **90** (82 readiness + 8 AI-security) | `node docs/investor/verify-claims.mjs` |
| Categories, weighted | **10** | same |
| Rules rated as launch blockers | **27** | same |
| Rules rated as degradations | **46** | same |
| Rules with a generated fix | **31** | same |
| Tests passing | **604** across 7 packages | `pnpm -r test` |
| Test-to-source ratio | **604 tests / ~32k lines** | `pnpm -r test`, LOC count |
| Packages | 8 (`core`, `cli`, `observer`, `compliance`, `einvoice`, `web`, `action`, `rules`) | `ls packages` |
| Commits | 13 | `git log --oneline` |
| CI/CD | GitHub Action w/ SARIF upload + PR comments | `packages/action` |
| Compliance frameworks generated | **5** (EU AI Act, GDPR, SOC 2, NIS2, CSRD) | `ls packages/compliance/templates` |
| Countries' e-invoice schemas | **1** (Brazil NFS-e) | `shipready validate --help` |
| Self-scan result | **62/100 (D+), 9 blockers, 32 findings** | `shipready scan .` |

Re-run `node docs/investor/verify-claims.mjs` before any pitch. These numbers
move every time you touch the rule catalogue.

### The number that actually matters

Scan accuracy on a codebase that has nothing to do with us:

| | Before | After |
|---|---|---|
| zod (65k lines) total findings | 130 | **86** |
| zod false database findings | 46 | **2** |
| zod database category | 0/100 | **71/100** |
| ShipReady itself, total findings | 59 | **32** |

That table is the single best thing in this document. It says: *we tested our
scanner against a mature codebase we have no stake in, found it was confidently
wrong, and fixed it.* Most scanner vendors have never run their tool on anything
except their own fixtures.

### And speed, which is the other half of "you can use this in CI"

| Repository | Cold scan | Throughput |
|---|---|---|
| 400 lines | 340ms | ~1,200 l/s |
| 12,000 lines | 700ms | ~17,000 l/s |
| 60,000 lines | 4.5s | ~13,000 l/s |

Scanning was **quadratic in file length** — `lineNoComments` re-split the whole
file on every call, so an 8,000-line file took 61 seconds and a 60k-line repo
took 39. Now 3.0s and 4.5s respectively. Reproduce with
`node docs/investor/bench.mjs`.

This matters competitively and it is worth saying out loud: a gate that takes
two minutes is a gate that gets disabled. Finding this required measuring rather
than assuming, and fixing it required reading the hot path rather than guessing.

---

## 4. Market

**[UNVERIFIED — do the research, then cite it.]** I have deliberately not filled
this in with numbers I cannot source. Placeholders to complete:

- **AI-assisted code volume.** % of commits AI-assisted at your target segment
  (GitClear/Coding-Speed data is the usual source).
- **Software failures that are pre-launch-detectable.** OWASP Top 10 coverage as
  a floor; the "AI-written code reintroduces known-vuln patterns" angle is the
  sharper claim and needs a citation.
- **EU AI Act enforcement dates** — obligations are phased by risk tier. This is
  the regulatory tailwind and it is *real and dated*. Get it right.
- **Who pays today:** the same teams already paying for Snyk, Datadog, Vanta,
  Cursor, or a fractional CTO. Name the budget line you are displacing.
- **TAM/SAM/SOM.** Bottom-up from developer count x ACV is more defensible than
  a top-down percentage of a market report.

---

## 5. Business model

**[UNVERIFIED]** No pricing has been set. Here is the shape the product implies,
with the reasoning exposed so you can argue with it:

**Open core.** The CLI and scanner are MIT. That is deliberate: the credibility
of a "your code is not ready" tool depends on anyone being able to run it, and a
closed scanner asking for trust before it has any is a hard sell.

Revenue should come from the things that need a server and a team:

| Tier | Price **[UNVERIFIED]** | What it is |
|---|---|---|
| OSS CLI + Action | free | scan, fix, check, SARIF |
| Team | ~$30/dev/mo | hosted dashboard, trend history, PR comments |
| Compliance | ~$200/mo | generated packs, jurisdiction packs, audit trail |
| Enterprise | custom | SSO, self-host, custom rules, SLA |

**The pricing insight worth leading with:** the CLI is the acquisition channel
and the dashboard is the lock-in. A team that has run `shipready check` in CI for
three months has a *trend line*, and nobody gives up a trend line showing their
production-readiness debt shrinking.

---

## 6. Competitive position

Be honest about this. The honest version is more persuasive than a table of
checkmarks.

| | ShipReady | Snyk / Semgrep | Cursor / Copilot | Vanta / Drata |
|---|---|---|---|---|
| Finds launch blockers | yes | partially | no | no |
| Agent runtime observability (cost, traces) | yes | no | no | no |
| AI-specific security (MCP, tool injection, agent perms) | yes | no | no | no |
| Generates compliance docs | yes | no | no | yes |
| e-invoice validation | yes | no | no | no |
| Priced for a solo dev / small team | yes | no | n/a | no |

**The wedge:** everything above is owned by a different vendor. Snyk owns
dependency scanning. Datadog owns observability. Vanta owns compliance paperwork.
Nobody owns *"an AI wrote this and nobody has checked whether it can survive
real users"* — which is a new category created by AI coding tools, and it did
not exist three years ago.

**Your most dangerous competitor is not a company. It is the absence of the
check.** Which is also why the OSS-first motion matters: you need the check to
be free and ubiquitous before the dashboard has any value.

---

## 7. Traction

**There is none yet, and you must say so first.** Zero users, zero revenue, no
npm downloads. Do not dress this up.

What you *do* have:

- A working, tested, self-hostable product (604 tests, clean build)
- 90 rules, 10 weighted categories, SARIF output, a GitHub Action
- 5 compliance frameworks generating real documents
- A dashboard with readiness trends, agent cost and invoice validation
- The accuracy work above, which is a genuine engineering signal

**What to ask for:** the honest version is *"I have built the thing and I need
the distribution to test whether anyone wants it."* Investors respond far better
to a specific, small, falsifiable ask than to a vague "help me grow."

Pick one: a design partner who ships AI-assisted code to real users, or a
security-minded engineer who will try the CLI on their own repo and tell you
honestly whether the findings are useful. **The second is more valuable**, and
much easier to get.

---

## 8. Risks — expect these questions, answer them yourself first

1. **"LLMs will just fix the false positives."**
   True, and it is why the accuracy work above matters more every quarter. But a
   model can only fix what you correctly flagged.

2. **"Isn't this what your code review / CI linter already does?"**
   Linters find style and type errors. These rules encode *production failure
   modes* — an N+1 at 100k rows, a transaction that half-commits, an AI endpoint
   with no rate limit. Different question, different blast radius.

3. **"What stops this becoming a feature of Copilot?"**
   Plausible, and it is the real long-term risk. Your defence is the cross-vendor
   position: people want to know whether their codebase is shippable regardless of
   which model wrote it, and a hosted dashboard with history is not something a
   model provider wants to build.

4. **"Your own repo scores 62/100 and isn't ready."**
   Yes — and it is in the demo on purpose. It proves the tool is not a marketing
   instrument. It is also real debt, which is what the seed money fixes first.

5. **"Compliance doc generation is a commodity."**
   The templates are; the *verification against your actual codebase* is not. A
   generated GDPR page that claims you have a retention policy you never wrote is
   worse than no document. That gap-detection is the product.

---

## 9. The ask

Fill this in. Do not present without it.

- **Amount:** [UNVERIFIED]
- **Runway:** [UNVERIFIED] months
- **Use of funds, in priority order:**
  1. Publish and drive the OSS CLI to adoption — this is the whole strategy
  2. Close the accuracy gap: rules as a data asset, per-language tuning, a
     public benchmark other vendors' scanners are measured against
  3. Compliance + hosted dashboard to production (the Drizzle adapter is genuinely
     unfinished — say so before they find it)
  4. EU AI Act enforcement timing — be ready the day it bites

---

## Appendix A — Honest state of the codebase

Say these before an investor finds them.

- **The Drizzle/Postgres adapter is not written.** The dashboard runs on a
  file-backed store in development. Selecting Postgres today throws a named
  error rather than pretending to work. This is the #1 engineering task.
- **No npm publish.** The packages are not on a registry yet.
- **No git remote.** Nothing has ever been pushed anywhere.
- **No docs site, no landing page, no pricing page.** All unbuilt.
- **The dashboard has no authentication.** Do not deploy it publicly.
- **1 of 5+ planned e-invoice countries shipped** (Brazil). Brazil first was a
  deliberate choice — highest regulatory pain, one standard, immediate payback.