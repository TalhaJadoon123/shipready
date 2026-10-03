# Contributing to ShipReady

Thanks for considering it. This is early, so there is a lot of latitude — but
the bar is high, and the reason is specific.

## The thing that makes this hard

Most static analysis tools have two problems: **false positives** and
**false negatives**. ShipReady's whole pitch is that it tells you what would
actually lose you data, money or trust. A rule that cries wolf on a mature
codebase destroys that instantly.

We found this the hard way. Pointed at [zod](https://github.com/colinhacks/zod) —
65k lines, no database anywhere — the database rules reported **46 findings,
more than a third of the entire report**. Four causes:

- a bare `\bpg\b` regex matched any `.pg(` namespace call, unlocking every
  database rule repo-wide
- the query patterns matched bare `.get(`, `.create(`, `.select()` — ordinary
  method names on ordinary objects
- `usesDatabase` was a project-wide question with no per-file equivalent
- the scanner read its own saved reports, which quote remediation text naming
  `DATABASE_URL`

**Every rule you add will be measured against codebases that have nothing to do
with this project.** A rule that only fires on our fixtures is not finished.

## Adding a rule

One scanner per rule, not per category. That keeps `disableRules` working per
rule id and keeps SARIF attribution clean.

```ts
defineRule(
  {
    id: 'readiness/category/short-slug',
    name: 'What is wrong, in one line',
    category: 'category',
    severity: 'high',              // critical | high | medium | low | info
    impact: 'blocker',              // blocker | degradation | cosmetic
    confidence: 0.75,               // < 0.5 does not appear in topBlockers
    effortMinutes: 30,
    fixable: false,                 // true only if shipready fix can generate it
    description: 'Why this loses data, money or trust...',
    remediation: 'The specific change to make...',
    compliance: [COMPLIANCE.owaspA09],
    tags: ['keyword'],
    references: ['https://...'],
  },
  function* (ctx, emit) {
    yield emit({ path: '...', line: 1, evidence: 'a sentence that reads correctly' });
  },
  (ctx) => /* applicability check */,
);
```

Rules that pass the applicability check run for the whole repository, so keep it
cheap and put the expensive work behind it.

### Three tests, always

1. **A true positive** in `packages/core/tests/fixtures.ts` — the vulnerable
   fixture must trigger it.
2. **A false-positive guard.** A small synthetic repo where the rule must *not*
   fire. This is the test people skip and it is the one that matters. Look at how
   `database checks > does not mistake ordinary code for database code` is
   structured.
3. **A regression test for any false positive you have ever shipped.** Commit it
   with a comment explaining what the old behaviour was, in the style of the
   `performance.test.ts` header.

## Two things that will bite you

**Comment and string masking.** `file.lineNoComments(n)` blanks comments;
`file.matchCode(re)` matches against masked text. Offsets are preserved, so a
match found in masked text still points at the right place in the original.

**Do not re-split content in a loop.** `SourceFile.lineNoComments` re-split the
whole file per call and made scanning quadratic — an 8,000-line file took 61
seconds. It is cached now. `buildLineIndex` is memoized. Read the comments in
`source.ts` before adding another per-line loop. There is a performance test
that will fail if you reintroduce this.

## Running things

```bash
pnpm -r build          # build all packages
pnpm -r test           # 610 tests
pnpm -r typecheck      # must be clean
node packages/cli/bin/shipready.mjs scan .
```

Scan your own changes before opening a PR. It is the tool in this repo, and it
scores 58/100 — mostly real debt we have not fixed yet.

`node docs/investor/verify-claims.mjs` re-derives the numbers quoted in the
README and the investor materials. If you change the rule catalogue, run it, and
update the README in the same commit — `rule-catalogue.test.ts` pins the counts.

## Commits

Write the message for someone reading `git log` in two years. Say what was
wrong and why the fix is the fix, not what files changed. Explain the non-obvious
decision: a reader should be able to tell why something is the way it is.

## Code of Conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE). By submitting a pull
request you confirm you have the right to submit the code and that it is your
own work or properly attributed.