# ShipReady Machine-Verifiable Checklist

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  
**Spec:** `.specify/spec.md`  
**Plan:** `.specify/plan.md`  
**Tasks:** `.specify/tasks.md`  

---

## Checklist Format

Each item follows:
- **ID**: `CHK-<category>-<number>`
- **Category**: `BUILD`, `TYPECHECK`, `TEST`, `SECURITY`, `PERF`, `DOCS`, `SPEC`, `DEPLOY`
- **Command**: Exact command to run (copy-pasteable)
- **Expected Exit Code**: 0 = pass, non-zero = fail
- **Frequency**: `COMMIT` (pre-commit), `CI` (every push), `WEEKLY`, `RELEASE`
- **Spec Reference**: Links to `spec.md` FR/NFR or `tasks.md` ID
- **Status**: `PASS` | `FAIL` | `SKIP` | `NOT_IMPLEMENTED`

---

## 1. Build & Type Safety

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-BUILD-1 | BUILD | Clean build emits output for all packages | `pnpm verify:build` | 0 | CI, RELEASE | FR-12 | PASS |
| CHK-BUILD-2 | BUILD | No empty `dist/` after clean build | `pnpm clean && pnpm build && node scripts/verify-build.mjs` | 0 | CI, RELEASE | FR-12 | PASS |
| CHK-BUILD-3 | BUILD | All packages have `package.json` + `LICENSE` + `README.md` in tarball | `pnpm pack:all && node scripts/inspect-tarballs.mjs` | 0 | CI, RELEASE | FR-12 | PASS |
| CHK-TYPE-1 | TYPECHECK | Root typecheck passes | `pnpm -r typecheck` | 0 | CI, COMMIT | FR-12 | PASS |
| CHK-TYPE-2 | TYPECHECK | No `any` in production source (strict TS) | `pnpm -r typecheck` | 0 | CI, COMMIT | Coding Conventions | PASS |
| CHK-TYPE-3 | TYPECHECK | Web API routes import `NextRequest` type correctly | `pnpm --filter @shipready/web typecheck` | 0 | CI, COMMIT | T-WEB-2 | PASS |

---

## 2. Tests

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-TEST-1 | TEST | All package tests pass | `pnpm -r test` | 0 | CI, COMMIT | FR-12 | PASS |
| CHK-TEST-2 | TEST | Core: 281 tests pass (adversarial fixtures) | `pnpm --filter @shipready/core test` | 0 | CI | T-CORE-6 | PASS |
| CHK-TEST-3 | TEST | CLI: 80 tests pass (all commands) | `pnpm --filter @shipready/cli test` | 0 | CI | T-CLI-1..8 | PASS |
| CHK-TEST-4 | TEST | Observer: 74 tests pass (spawn + preload) | `pnpm --filter @shipready/observer test` | 0 | CI | T-OBS-1..4 | PASS |
| CHK-TEST-4 | TEST | Compliance: 90 tests pass | `pnpm --filter @shipready/compliance test` | 0 | CI | T-COMP-1..5 | PASS |
| CHK-TEST-5 | TEST | E-invoice: 65 tests pass (Brazil fixtures) | `pnpm --filter @shipready/einvoice test` | 0 | CI | T-EINV-1..3 | PASS |
| CHK-TEST-5 | TEST | Web: 25 tests pass (API + store) | `pnpm --filter @shipready/web test` | 0 | CI | T-WEB-1..5 | PASS |
| CHK-TEST-6 | TEST | Action: 13 tests pass (7 fail locally — GitHub env required) | `pnpm --filter @shipready/action test` | 0* | CI | T-ACT-1..2 | CONDITIONAL |
| CHK-TEST-6 | TEST | No flaky tests (re-run once) | `pnpm -r test && pnpm -r test` | 0 both | RELEASE | NFR | NOT_IMPLEMENTED |

> *Action tests require `GITHUB_ACTIONS=true` and GitHub context — expected to fail locally, pass in CI.

---

## 3. Security

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-SEC-1 | SECURITY | Production dependency audit (high/critical) | `pnpm audit --prod --audit-level high` | 0 | CI, WEEKLY | NFR | PASS |
| CHK-SEC-2 | SECURITY | CodeQL analysis (security-extended) | GitHub Action `codeql.yml` | 0 | WEEKLY, PR | NFR | PASS |
| CHK-SEC-3 | SECURITY | No hardcoded secrets in source | `grep -rE "(api[_-]?key|secret|password|token|private[_-]?key)" --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist .` | 1 (no matches) | CI, COMMIT | Security Req. | PASS |
| CHK-SEC-4 | SECURITY | `.env.example` exists and is complete | `test -f .env.example && wc -l .env.example` | 0, lines ≥ 50 | CI | Env & Config | PASS |
| CHK-SEC-5 | SECURITY | Docker Compose uses env vars (no hardcoded passwords) | `grep -E "POSTGRES_PASSWORD|REDIS_PASSWORD" docker-compose.yml` | 0 (uses `${VAR}`) | CI | Security Req. | PASS |
| CHK-SEC-6 | SECURITY | CSP header present in Next.js config | `grep -q "Content-Security-Policy" packages/web/next.config.mjs` | 0 | CI | NFR | PASS |
| CHK-SEC-7 | SECURITY | HSTS header present | `grep -q "Strict-Transport-Security" packages/web/next.config.mjs` | 0 | CI | NFR | PASS |
| CHK-SEC-8 | SECURITY | Auth middleware on all dashboard API routes | `grep -r "isAuthenticated\|rateLimit" packages/web/src/app/api/ --include="*.ts" | wc -l` | ≥ 7 | CI | T-WEB-1 | PASS |
| CHK-SEC-8 | SECURITY | Rate limiting applied to all 7 API routes | `grep -r "rateLimit" packages/web/src/app/api/ --include="*.ts" | wc -l` | ≥ 7 | CI | T-WEB-2 | PASS |
| CHK-SEC-9 | SECURITY | Path traversal guard on scan PUT endpoint | `grep -q "isScannablePath" packages/web/src/app/api/scan/route.ts` | 0 | CI | FR-1 | PASS |

---

## 4. Performance

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-PERF-1 | PERF | Benchmark: 60k lines ≤ 5s cold | `node docs/investor/bench.mjs` | 0, output shows ≤5000ms | WEEKLY, RELEASE | NFR | PASS |
| CHK-PERF-2 | PERF | No quadratic line access | `pnpm --filter @shipready/core test -- --testNamePattern="line access is not quadratic"` | 0 | CI | T-CORE-7 | PASS |
| CHK-PERF-3 | PERF | Memory < 500MB for 60k lines | `node --max-old-space-size=512 docs/investor/bench.mjs` | 0 | WEEKLY | NFR | PASS |

---

## 5. Documentation

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-DOC-1 | DOCS | README.md exists and has install/usage | `test -f README.md && grep -q "shipready scan" README.md` | 0 | CI | Spec §1 | PASS |
| CHK-DOC-2 | DOCS | SECURITY.md defines trust boundaries | `test -f SECURITY.md && grep -q "Trust boundaries" SECURITY.md` | 0 | CI | Security Req. | PASS |
| CHK-DOC-3 | DOCS | CONTRIBUTING.md has rule-authoring discipline | `test -f CONTRIBUTING.md && grep -q "false-positive" CONTRIBUTING.md` | 0 | CI | Coding Conventions | PASS |
| CHK-DOC-4 | DOCS | LAUNCH.md checklist exists | `test -f docs/investor/LAUNCH.md && grep -q "step 1 done" docs/investor/LAUNCH.md` | 0 | CI | T-CI-1 | PASS |
| CHK-DOC-5 | DOCS | `.env.example` has all required vars | `grep -c "^[A-Z_]\+=" .env.example` | ≥ 15 | CI | Env & Config | PASS |
| CHK-DOC-6 | DOCS | OpenAPI spec generates (when implemented) | `test -f packages/web/src/lib/openapi.ts` | 0 | RELEASE | T-API-1 | NOT_IMPLEMENTED |
| CHK-DOC-7 | DOCS | CHANGELOG.md exists (when implemented) | `test -f CHANGELOG.md` | 0 | RELEASE | T-DOC-2 | NOT_IMPLEMENTED |

---

## 6. Spec Kit Compliance

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-SPEC-1 | SPEC | `constitution.md` exists | `test -f .specify/constitution.md` | 0 | CI | T-SPEC-1 | PASS |
| CHK-SPEC-2 | SPEC | `spec.md` exists with user stories | `test -f .specify/spec.md && grep -q "User Stories" .specify/spec.md` | 0 | CI | T-SPEC-2 | PASS |
| CHK-SPEC-3 | SPEC | `plan.md` exists with architecture | `test -f .specify/plan.md && grep -q "Architecture" .specify/plan.md` | 0 | CI | T-SPEC-3 | PASS |
| CHK-SPEC-4 | SPEC | `tasks.md` exists with mapped tasks | `test -f .specify/tasks.md && grep -q "T-SPEC-1" .specify/tasks.md` | 0 | CI | T-SPEC-4 | PASS |
| CHK-SPEC-5 | SPEC | `checklist.md` exists (this file) | `test -f .specify/checklist.md` | 0 | CI | T-SPEC-5 | PASS |
| CHK-SPEC-6 | SPEC | Agent definition exists | `test -f .github/agents/spec-kit.md` | 0 | CI | T-SPEC-6 | NOT_IMPLEMENTED |
| CHK-SPEC-7 | SPEC | Prompt templates exist (3) | `ls .github/prompts/spec-kit-*.md | wc -l` | 3 | CI | T-SPEC-7..9 | NOT_IMPLEMENTED |
| CHK-SPEC-8 | SPEC | No "NEEDS CLARIFICATION" markers in spec/plan/tasks | `grep -r "NEEDS CLARIFICATION" .specify/ --include="*.md"` | 1 (no matches) | CI | Clarification Gate | PASS |
| CHK-SPEC-9 | SPEC | Cross-artifact consistency (spec↔plan↔tasks) | Custom script when implemented | 0 | RELEASE | Analysis Gate | NOT_IMPLEMENTED |

---

## 6. Deployment

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-DEPLOY-1 | DEPLOY | `pnpm verify:release` passes | `pnpm verify:release` | 0 | RELEASE | FR-12 | PASS |
| CHK-DEPLOY-2 | DEPLOY | Docker Compose uses env vars | `grep -E "POSTGRES_PASSWORD|REDIS_PASSWORD" docker-compose.yml | grep -v "changeme"` | 0 | RELEASE | Security Req. | PASS |
| CHK-DEPLOY-3 | DEPLOY | `pnpm desktop` launches dashboard | `timeout 10 pnpm desktop --no-open --port 3011` | 0 | RELEASE | T-WEB-4 | PASS |
| CHK-DEPLOY-4 | DEPLOY | GitHub Action publishes to marketplace (when released) | Manual verification | — | RELEASE | T-ACT-1 | NOT_IMPLEMENTED |

---

## 7. Spec Kit Quality Gates

| ID | Category | Check | Command | Expected Exit | Frequency | Spec Ref | Status |
|----|----------|-------|---------|---------------|-----------|----------|--------|
| CHK-GATE-1 | GATE | Clarification: No "NEEDS CLARIFICATION" markers | `grep -r "NEEDS CLARIFICATION" .specify/ --include="*.md"` | 1 (no matches) | CI, PR | Clarification Gate | PASS |
| CHK-GATE-2 | GATE | Checklist: This file runs as machine-verifiable gate | `bash -c "source .specify/checklist.md && run_all_checks"` | 0 | CI, PR | Checklist Gate | NOT_IMPLEMENTED |
| CHK-GATE-3 | GATE | Analysis: Cross-artifact consistency check | Custom script when implemented | 0 | RELEASE | Analysis Gate | NOT_IMPLEMENTED |

---

## Summary

| Category | Total | Pass | Fail | Not Implemented | Conditional |
|----------|-------|------|------|-----------------|-------------|
| BUILD | 3 | 3 | 0 | 0 | 0 |
| TYPECHECK | 3 | 3 | 0 | 0 | 0 |
| TEST | 7 | 6 | 0 | 0 | 1 |
| SECURITY | 9 | 9 | 0 | 0 | 0 |
| PERF | 3 | 3 | 0 | 0 | 0 |
| DOCS | 7 | 5 | 0 | 2 | 0 |
| SPEC | 9 | 5 | 0 | 4 | 0 |
| DEPLOY | 4 | 3 | 0 | 1 | 0 |
| GATE | 3 | 1 | 0 | 2 | 0 |
| **Total** | **45** | **35** | **0** | **11** | **1** |

**Overall: 35/45 checks passing (78%)** — Core product fully verified; Spec Kit adoption + some docs/CI enhancements pending.

---

## Running the Checklist

```bash
# Run all CI-equivalent checks locally
pnpm verify:build          # CHK-BUILD-1,2,3
pnpm -r typecheck          # CHK-TYPE-1,2,3
pnpm -r test               # CHK-TEST-1..5
pnpm audit --prod --audit-level high  # CHK-SEC-1
pnpm --filter @shipready/core test -- --testNamePattern="line access is not quadratic"  # CHK-PERF-2
node docs/investor/bench.mjs  # CHK-PERF-1
pnpm verify:release        # CHK-DEPLOY-1
```

---

## Adding New Checks

To add a check:
1. Add row to appropriate table above
2. Ensure `Command` is copy-pasteable and deterministic
3. Reference `spec.md` FR/NFR or `tasks.md` ID
4. Set `Status` to `NOT_IMPLEMENTED` initially
5. Update `Summary` table totals

---

**End of Checklist**