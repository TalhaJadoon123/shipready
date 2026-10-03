# MEMORY

Project: **ShipReady** — production-readiness and agent-observability platform for AI-built codebases.
Monorepo, pnpm workspaces, 7 packages. MIT. Working branch `master`.

## Last verified state

- Commit `319b626` "web: dashboard UI, file-backed store, and demo seed" (parent `015194f`)
- Working tree clean
- **598 tests passing, 0 failures**: core 258, compliance 90, cli 78, observer 69, einvoice 65, web 25, action 13
- `pnpm -r build` clean (all 7 packages incl. Next.js dashboard)
- `pnpm -r typecheck` clean (all 7 packages)
- Self-scan of this repo: **64/100 (D+), NOT READY, 7 blockers** (real debt, see Open items)

## Architecture decisions (do not undo without reading the comment)

- **Regex/masked-text rules, not tree-sitter.** Heuristics over `maskComments` /
  `maskCommentsAndStrings` keep the dependency surface small and tests fast.
  Documented as a future improvement.
- **One scanner per rule**, not per category, so `disableRules` works per-id and
  SARIF attribution stays clean.
- **Observer preload is a checked-in `.cjs`** (`packages/observer/preload.cjs`),
  not generated ESM. Reason: `node -e "process.exit(1)"` exits before an async
  dynamic import resolves, so ESM would lose the fastest-failing agents.
  The preload is only a sensor; all pricing/aggregation happens in the parent.
- **`parseCommand` does not treat backslash as an escape.** It was destroying
  Windows paths.
- **Compliance/observer data is not persisted server-side.** Documents stay on
  the user's filesystem; trace events stay in local SQLite. They are records
  about the customer's business, not ours.
- **Exit-code contract everywhere**: `0` pass, `1` threshold/blocker, `2`
  could-not-run.
- **Test/fixture/template/rule-catalogue files excluded from default scans.** The
  scanner was otherwise reporting its own rule descriptions as vulnerabilities.

## Dashboard (packages/web) — most recent work

Stack: Next.js 15 app router, React 19, plain CSS (no framework), server-rendered.

- `src/app/globals.css` — design system, dark instrument panel. Colour is only
  ever used to encode a verdict, severity or cost.
- `src/app/page.tsx` — the dashboard. Server component; first paint already has data.
- `src/components/charts.tsx` — hand-rolled SVG: score ring, radar, trend line,
  severity bars, activity heatmap, cost chart. No charting dependency.
- `scripts/seed.ts` — demo data via `pnpm --filter @shipready/web seed`.
  Builds a synthetic repo that gains the file resolving one blocker per step and
  runs the **real scanner** on it, so the trend is genuine output.
- `src/db/client.ts` — file-backed store, snapshots to
  `.shipready/dashboard.json` on every mutation.
- `src/lib/store.ts` — `store()` guard that throws a named error if the selected
  driver lacks the operation surface.

Run it: `pnpm --filter @shipready/web seed` then `pnpm --filter @shipready/web dev`
(port 3001).

### Bugs found and fixed while building the UI (all were real)

1. `insertScan` stored `report: payload` — the denormalised wrapper — so the
   genuine report landed at `scan.report.report` and `categories` was a keyed map
   instead of an array. Fixed in `packages/web/src/db/client.ts`.
2. `topBlockers()` (`packages/core/src/scoring.ts:164`) is **deduped by rule and
   capped at 5**. Its length is a display budget, not a count — do not use it as
   a total. Use `summary.blockers`.
3. `formatUsd` hardcodes `$`; BRL invoices need `R$`.
4. React cannot serialise an array of children into a `<title>` — use a template
   string.
5. `className="pill {severity}"` is a literal string and never matched; needs a
   template literal.

## Performance (commit 5ff79af) — do not regress

Scanning was **quadratic in file length**: `SourceFile.lineNoComments` re-split
the whole file on every call, and rules call it per line inside loops that also
iterate lines. An 8,000-line file took 61s. Also fixed: eager comment masking,
`hasExplanatoryCommentNear` scanning all comments per call (now indexed by
line), `buildLineIndex` rebuilt per rule (now memoized 2-entry), `matchLines`
recompiling its RegExp per line.

60k-line repo: 39s -> 4.5s. Single 8k file: 61s -> 3.0s. Self-scan 8.5s ->
1.5s. `docs/investor/bench.mjs` reproduces it; `tests/performance.test.ts` pins
the linear behaviour by ratio (verified to fail if the cache is removed).

## Launch state (commit bb1e94d)

`docs/investor/LAUNCH.md` is the ordered path to release.

**Hard blocker: nothing is on npm.** The CLI depends on five workspace packages,
so all six must be published before any install works — a naive install gives
`ERR_PNPM_FETCH_404 @shipready/einvoice`. Publish order: core, rules, einvoice,
compliance, observer, then cli last. The code is fine — verified working from a
clean tarball install outside the monorepo.

Also outstanding: no git remote (nothing pushed), no landing page, no pricing,
no CI on this repo, dashboard has **no authentication** (must not be deployed
publicly), and the **Drizzle/Postgres adapter is unwritten**.

## Open items

**Never configured: `git remote -v` / no push has ever happened.** No remote is
set up. This is still outstanding.

**Scanner accuracy work (commit 9cce153) — do not regress.** Measured against
zod (65k lines, no database). Four causes of repo-wide false positives, all
fixed: bare `\bpg\b` matching any `.pg(`; bare `.get(`/`.create(`/`.select()`
matching ordinary method names; no per-file DB gate (only project-wide); and the
scanner reading its own saved reports (they quote remediation text naming
DATABASE_URL). zod: 130 -> 86 findings, DB category 0/100 -> 71/100. Five
regression tests pin each one. **`ORMS` matching is substring-based** because
Prisma installs as `@prisma/client`; plain set membership silently fails.

**Real gaps I left rather than papering over:**

- The Drizzle adapter for Postgres/PGlite is **not written**. `createDatabase()`
  returns raw Drizzle builders that do not implement the surface `store.ts`
  calls. Selecting those drivers now throws a clear named error. Production
  (`NODE_ENV=production` with no `DATABASE_URL`) is therefore not actually
  usable yet — this is the biggest hole in the dashboard.
- Self-scan blockers: no tenant-auth middleware on
  `packages/web/src/app/api/*/route.ts`; floating promises in
  `packages/observer/src/runtime.ts:235,344` and
  `packages/observer/preload.cjs:60,266,482`; no rate limiting in
  `packages/compliance/src/scan.ts`.
- Spec phases not yet built: `packages/docs` (Fumadocs site), landing page / GTM
  assets (Product Hunt, HN, Reddit, blog post), pricing pages, CONTRIBUTING.md,
  CODE_OF_CONDUCT.md, SECURITY.md.

## Environment notes / gotchas

- Shell is **PowerShell**. No heredocs (`<<EOF` fails) — write the commit message
  to a file and use `git commit -F <file>`.
- **Do not use PowerShell `.Replace()` on multi-line strings.** It corrupted files
  repeatedly. Use the `edit` tool instead.
- Extracting test counts from output requires stripping ANSI escapes.
- Git identity was unset in this environment; set locally with
  `git config user.name "ShipReady"` / `user.email "build@shipready.ai"`
  (matches existing commit history).
- Background `pnpm dev` processes are killed when a turn ends. Restart to view.
- `packages/web/next.config.mjs` `extensionAlias` maps `.js`→`.ts`/`.tsx`;
  required for the build.
- `packages/web/src/db/client.ts` uses `Database = unknown` because the PGlite
  type cannot be named across the pnpm store.
- Test-count/test isolation: web tests set `SHIPREADY_MEMORY_PATH=''` to keep the
  file-backed store purely in-process.

## Rule-catalogue coupling

`README.md` quotes 82 readiness + 8 AI-security rule counts, asserted by
`packages/core/tests/rule-catalogue.test.ts`. **Changing rule counts breaks that
test** — update the README in the same commit.

## Key files

- `packages/core/src/fsutil/walk.ts` — default exclusions incl. `/src/scanners/readiness/`. Critical for scan accuracy.
- `packages/core/src/fsutil/detect.ts` — `detectTests()` reads the dir tree, not the walk list. Regression risk if reverted.
- `packages/core/src/scanners/readiness/security.ts` — `middlewareGuardsApi()`, `isNextRoute()`; string-masked matching for CORS/innerHTML.
- `packages/core/src/scanners/readiness/error-handling.ts` — `chainHasHandlerBelow()` multi-line promise-chain logic.
- `packages/core/tests/fixtures.ts` — vulnerable + production-ready repo pair driving 49 end-to-end scanner tests.
- `packages/action/index.mjs` — resolves CLI by walking up; exit codes 0/1/2.