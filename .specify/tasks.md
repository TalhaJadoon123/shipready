# ShipReady Tasks

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  
**Spec:** `.specify/spec.md`  
**Plan:** `.specify/plan.md`  

---

## Task Format

Each task follows:
- **ID**: `T-<category>-<number>` (e.g., `T-SPEC-1`)
- **Category**: `SPEC`, `CORE`, `CLI`, `WEB`, `OBS`, `COMP`, `EINV`, `ACTION`, `INFRA`, `DOCS`
- **Dependencies**: Task IDs that must complete first
- **User Story**: From `spec.md`
- **Acceptance Criteria**: Machine-verifiable where possible
- **Status**: `TODO` | `IN_PROGRESS` | `DONE`
- **Priority**: `P0` (must-have), `P1` (should-have), `P2` (nice-to-have)

---

## 1. Spec Kit Adoption (P0)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-SPEC-1 | SPEC | Create `.specify/constitution.md` | — | US-1.1–1.4, 2.1–2.4, 3.1–3.3, 4.1–4.2, 5.1–5.2, 6.1–6.2 | File exists at `.specify/constitution.md`; covers all 8 sections; references constitution in plan | DONE | P0 |
| T-SPEC-2 | SPEC | Create `.specify/spec.md` | T-SPEC-1 | All US | File exists at `.specify/spec.md`; 6 user story groups; 12 FRs, 8 NFRs; glossary | DONE | P0 |
| T-SPEC-3 | SPEC | Create `.specify/plan.md` | T-SPEC-2 | All US | File exists at `.specify/plan.md`; architecture, data model, interfaces, decisions, constitution check | DONE | P0 |
| T-SPEC-4 | SPEC | Create `.specify/tasks.md` | T-SPEC-3 | All US | **This file** — all tasks mapped to user stories with acceptance criteria | DONE | P0 |
| T-SPEC-5 | SPEC | Create `.specify/checklist.md` | T-SPEC-4 | All US | Machine-verifiable checklist; CI gates mapped to checklist items | TODO | P0 |
| T-SPEC-6 | SPEC | Create `.github/agents/spec-kit.md` | T-SPEC-1 | — | Agent definition for Spec Kit workflow | TODO | P0 |
| T-SPEC-7 | SPEC | Create `.github/prompts/spec-kit-clarify.md` | T-SPEC-6 | — | Prompt finds "NEEDS CLARIFICATION" markers | TODO | P0 |
| T-SPEC-8 | SPEC | Create `.github/prompts/spec-kit-checklist.md` | T-SPEC-6 | — | Prompt runs machine-verifiable checklist | TODO | P0 |
| T-SPEC-9 | SPEC | Create `.github/prompts/spec-kit-analyze.md` | T-SPEC-6 | — | Prompt runs cross-artifact consistency check | TODO | P0 |

---

## 2. Core Scanning Engine (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-CORE-1 | CORE | 82 readiness rules implemented | — | US-1.1 | 82 rules across 10 categories; `rule-catalogue.test.ts` pins counts | DONE | P0 |
| T-CORE-2 | CORE | 8 AI-security rules implemented | — | US-1.1 | 8 rules in `packages/core/src/scanners/ai-security/index.ts` | DONE | P0 |
| T-CORE-3 | CORE | Weighted scoring + blocker separation | — | US-1.1 | Score 0–100; verdict mapping; blockers separate in summary | DONE | P0 |
| T-CORE-4 | CORE | SARIF 2.1.0 output | — | US-1.2 | `formatReport(..., 'sarif')` produces valid SARIF; GitHub accepts upload | DONE | P0 |
| T-CORE-5 | CORE | `--fix` generates 10 fix types | — | US-1.4 | `autofix/` templates: error middleware, health probes, Dockerfile, rate limit, validation, logging, Sentry, CI, security headers, metrics | DONE | P0 |
| T-CORE-6 | CORE | Adversarial fixtures + false-positive guards | — | US-1.1 | `core/tests/fixtures.ts` (vulnerable + ready); every rule has false-positive test | DONE | P0 |
| T-CORE-7 | CORE | Performance: sub-linear scan | — | NFR | `performance.test.ts` asserts line-access not quadratic | DONE | P0 |
| T-CORE-8 | CORE | Self-scan gate in CI | — | FR-12 | `verify-claims.mjs` runs in CI; verifies README numbers | DONE | P0 |

---

## 3. CLI (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-CLI-1 | CLI | `scan`, `fix`, `observe`, `comply`, `validate`, `convert` commands | T-CORE-1 | US-1.1–1.4, 2.1–2.4, 3.1–3.3, 4.1–4.2 | All 6 commands registered in `program.ts`; help text; exit codes | DONE | P0 |
| T-CLI-2 | CLI | `--baseline` regression mode | T-CLI-1 | US-1.3 | First run exits 0; subsequent runs fail only on regression | DONE | P0 |
| T-CLI-3 | CLI | `--fix --apply` writes files with `requires-review` | T-CLI-1 | US-1.4 | Dry-run shows diff; `--apply` writes; each file has `// requires-review` | DONE | P0 |
| T-CLI-4 | CLI | `observe -- <cmd>` spawns + preload | T-CORE-1 | US-2.1 | Spawns agent; injects `preload.cjs`; captures LLM/tools/files/network/decisions | DONE | P0 |
| T-CLI-5 | CLI | `observe report|replay|compare|list|cost` subcommands | T-CLI-4 | US-2.2–2.3 | HTML report, TUI replay, trace compare, list, cost summary | DONE | P0 |
| T-CLI-6 | CLI | `--cost-budget` enforcement | T-CLI-4 | US-2.4 | Tracks running cost; emits anomaly; exits non-zero on breach | DONE | P0 |
| T-CLI-7 | CLI | `comply init|scan|generate` | T-CORE-1 | US-3.1–3.3 | Questionnaire + templates; scan for PII; generate pack + gap report | DONE | P0 |
| T-CLI-8 | CLI | `validate|convert` for Brazil NFS-e/NF-e | T-CORE-1 | US-4.1–4.2 | CNPJ/CPF check digits, ISS, arithmetic, duplicates; `--fix` corrects provable | DONE | P0 |

---

## 4. Observer (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-OBS-1 | OBS | Preload intercepts `fetch`, `fs`, `child_process`, `console` | T-CLI-4 | US-2.1 | `preload.cjs` wraps globals; emits JSONL to stderr | DONE | P0 |
| T-OBS-2 | OBS | SQLite trace store (better-sqlite3) | T-OBS-1 | US-2.1 | `TraceStore` creates schema; writes events; WAL mode | DONE | P0 |
| T-OBS-3 | OBS | HTML report with cost/tokens/heatmap | T-OBS-2 | US-2.2 | `html.ts` generates `report.html` with charts | DONE | P0 |
| T-OBS-4 | OBS | TUI replay + trace compare | T-OBS-2 | US-2.3 | `tui.ts` interactive; `compare` shows diff | DONE | P0 |
| T-OBS-4 | OBS | `--cost-budget` anomaly + exit code | T-CLI-6 | US-2.4 | Tracks cost; emits anomaly; exits non-zero | DONE | P0 |

---

## 5. Compliance (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-COMP-1 | COMP | Questionnaire (EU AI Act, GDPR, CSRD, NIS2, SOC2) | — | US-3.1 | `questionnaire.ts` with `why` for each question | DONE | P0 |
| T-COMP-2 | COMP | Templates (13 files across 5 frameworks) | T-COMP-1 | US-3.1 | `templates/` dir: csrd(3), eu-ai-act(5), gdpr(3), nis2(1), soc2(1) | DONE | P0 |
| T-COMP-3 | COMP | `comply scan` detects PII in code | T-COMP-1 | US-3.2 | `scan.ts` finds personal data patterns in source | DONE | P0 |
| T-COMP-4 | COMP | `comply generate` produces pack + gap report | T-COMP-1 | US-3.3 | Generates Markdown/JSON/DOCX; gap report per document | DONE | P0 |
| T-COMP-5 | COMP | Dashboard stores version record only | T-COMP-4 | US-3.3 | `storeCompliance` saves score/frameworks/gaps; not documents | DONE | P0 |

---

## 4. E-Invoice (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-EINV-1 | EINV | Brazil NFS-e/NF-e validation | — | US-4.1 | CNPJ/CPF check digits, ISS tax codes, arithmetic recomputation, duplicates | DONE | P0 |
| T-EINV-2 | EINV | `--fix` corrects provable errors only | T-EINV-1 | US-4.1 | Fixes check digits, arithmetic; refuses to guess missing data | DONE | P0 |
| T-EINV-3 | EINV | `convert --to csv` | T-EINV-1 | US-4.2 | Outputs CSV with line items, totals, tax breakdown | DONE | P0 |

---

## 5. GitHub Action (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-ACT-1 | ACTION | Action entry point (`action/index.mjs`) | T-CLI-1 | US-5.1 | Spawns CLI; parses inputs; posts PR comment; uploads SARIF | DONE | P0 |
| T-ACT-2 | ACTION | `threshold`, `baseline`, `fail-on`, `format`, `sarif-output` inputs | T-ACT-1 | US-5.1–5.2 | All inputs documented; validated; exit codes match CLI | DONE | P0 |

---

## 5. Dashboard (P0 — Already Done)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-WEB-1 | WEB | Next.js 15 dashboard with middleware auth | T-CORE-1 | US-6.1 | `middleware.ts` auth + rate limit; `SHIPREADY_DASHBOARD_TOKEN` | DONE | P0 |
| T-WEB-2 | WEB | API routes (7 endpoints) with auth + rate limit | T-WEB-1 | US-6.2 | All 7 routes: auth + rate limit; Zod validation | DONE | P0 |
| T-WEB-3 | WEB | Dashboard UI: trends, radar, cost, compliance, invoices | T-WEB-2 | US-6.1 | `page.tsx` renders all sections; charts from `components/charts.tsx` | DONE | P0 |
| T-WEB-4 | WEB | Desktop launcher (`pnpm desktop`) | T-WEB-1 | US-6.1 | `apps/desktop/scripts/launch.mjs` builds, seeds, polls health, opens browser | DONE | P0 |
| T-WEB-5 | WEB | CSP + HSTS + security headers | T-WEB-1 | NFR | `next.config.mjs` headers; middleware CORS | DONE | P0 |

---

## 6. CI/CD & Infrastructure (P1 — In Progress / Planned)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-CI-1 | INFRA | CI: matrix Node 20.10/22, audit, verify:build, typecheck, test, pack, verify-claims | — | FR-12 | `.github/workflows/ci.yml` all steps pass | DONE | P1 |
| T-CI-2 | INFRA | CodeQL SAST workflow (weekly + PR) | — | NFR | `.github/workflows/codeql.yml` runs security-extended | DONE | P1 |
| T-CI-3 | INFRA | `verify:release` script (clean → build → typecheck → test → pack) | T-CI-1 | FR-12 | `pnpm verify:release` exits 0 | DONE | P1 |
| T-CI-4 | INFRA | Dependabot config | T-CI-1 | — | `.github/dependabot.yml` weekly updates | TODO | P1 |
| T-CI-5 | INFRA | Semantic-release workflow | T-CI-1 | — | Conventional commits → version → changelog → npm publish | TODO | P1 |
| T-CI-6 | INFRA | Terraform infra modules (AWS/GCP) | — | — | `infra/terraform/` modules for ECS/Fargate, RDS, ElastiCache | TODO | P2 |

---

## 7. Dashboard API & OpenAPI (P1)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-API-1 | DOCS | OpenAPI 3.1 spec for all 7 endpoints | T-WEB-2 | — | `packages/web/src/lib/openapi.ts` generates spec; Redoc at `/docs` | TODO | P1 |
| T-API-2 | DOCS | CHANGELOG.md auto-generated | — | — | `.github/workflows/changelog.yml` + `conventional-changelog` | TODO | P1 |

---

## 8. Observability & Reliability (P1)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-OBSV-1 | OBSV | Structured JSON logger with request IDs | T-CORE-1 | NFR | `packages/core/src/logger.ts` with levels, optional Sentry | TODO | P1 |
| T-OBSV-2 | OBSV | Retry + circuit breaker for external HTTP | T-CORE-1 | NFR | `packages/core/src/retry.ts` with exponential backoff + breaker | TODO | P1 |
| T-OBSV-3 | OBSV | Zod-validated env config | T-CORE-1 | — | `packages/core/src/config.ts` schema for all `process.env` | TODO | P1 |
| T-OBSV-4 | OBSV | CSP nonce + report-uri endpoint | T-WEB-5 | NFR | `next.config.mjs` nonce; `app/api/csp-report/route.ts` collector | TODO | P1 |

---

## 9. Documentation (P1)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-DOC-1 | DOCS | OpenAPI 3.1 + Redoc at `/docs` | T-API-1 | — | `packages/web/src/lib/openapi.ts` + `app/api/docs/route.ts` | TODO | P1 |
| T-DOC-2 | DOCS | Auto-generated CHANGELOG.md | — | — | `.github/workflows/changelog.yml` + `conventional-changelog` | TODO | P1 |
| T-DOC-3 | DOCS | ADR 0001: Monorepo structure | — | — | `docs/adr/0001-monorepo-structure.md` | TODO | P2 |
| T-DOC-4 | DOCS | Cost awareness guide | — | NFR | `docs/cost-awareness.md` with billing alerts, resource sizing | TODO | P2 |

---

## 9. LLM/AI Evaluation (P2)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-AI-1 | AI | Prompt regression test framework | T-OBS-3 | NFR | `packages/ai-eval/` with prompt tests, hallucination detection | TODO | P2 |
| T-AI-2 | AI | Model routing/fallback | T-OBSV-2 | NFR | Primary + fallback providers with automatic failover | TODO | P2 |

---

## 10. ADRs (P2)

| ID | Category | Title | Dependencies | User Story | Acceptance Criteria | Status | Priority |
|----|----------|-------|--------------|------------|---------------------|--------|----------|
| T-ADR-1 | DOCS | ADR 0001: Monorepo (Turborepo + pnpm) | — | — | `docs/adr/0001-monorepo-structure.md` | TODO | P2 |
| T-ADR-2 | DOCS | ADR 0002: Next.js vs Remix | — | — | `docs/adr/0002-nextjs-vs-remix.md` | TODO | P2 |
| T-ADR-3 | DOCS | ADR 0003: better-sqlite3 vs PGlite | — | — | `docs/adr/0003-sqlite-choice.md` | TODO | P2 |
| T-ADR-4 | DOCS | ADR 0004: ESM vs CJS | — | — | `docs/adr/0004-esm-vs-cjs.md` | TODO | P2 |

---

## Summary

| Category | Total | Done | Todo | In Progress |
|----------|-------|------|------|-------------|
| SPEC | 9 | 4 | 5 | 0 |
| CORE | 8 | 8 | 0 | 0 |
| CLI | 8 | 8 | 0 | 0 |
| OBS | 5 | 5 | 0 | 0 |
| COMP | 5 | 5 | 0 | 0 |
| EINV | 3 | 3 | 0 | 0 |
| ACTION | 2 | 2 | 0 | 0 |
| WEB | 5 | 5 | 0 | 0 |
| INFRA | 6 | 3 | 3 | 0 |
| DOCS | 4 | 0 | 4 | 0 |
| OBSV | 4 | 0 | 4 | 0 |
| AI | 2 | 0 | 2 | 0 |
| **Total** | **66** | **44** | **22** | **0** |

**Completion: 67%** (core product complete; Spec Kit adoption + observability + docs remaining)

---

**End of Tasks**