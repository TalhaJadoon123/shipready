# ShipReady Specification

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  

---

## 1. Overview

**Product:** ShipReady — The production-readiness layer for AI-built software.  
**Tagline:** "Vibe-coded. Production-proven."  
**Core Question:** "Is this ready for real users?"

ShipReady is a CLI-first toolkit that scans codebases, observes AI agents, generates compliance documentation, validates e-invoices, and provides a dashboard — all behind a single `shipready` command.

---

## 2. User Stories

### 2.1 Production Readiness Scan

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-1.1 | As a developer, I want to run `shipready scan .` on my repo so I get a 0–100 score with blockers listed separately. | Score 0–100; verdict (PRODUCTION READY / READY WITH CAVEATS / NEEDS WORK / NOT READY); blockers listed with remediation and effort estimates. |
| US-1.2 | As a CI/CD pipeline, I want `shipready scan . --format sarif -o out.sarif` so I can upload results to GitHub Code Scanning. | Valid SARIF 2.1.0 output; uploads to GitHub Security tab; includes rule IDs, locations, severity. |
| US-1.3 | As a team lead, I want `shipready scan . --baseline` so the gate fails only on regressions, not absolute score. | Exit 0 on first run; subsequent runs fail only if score drops or new blockers appear. |
| US-1.4 | As a developer, I want `shipready fix . --apply` so blockers are auto-fixed with generated code. | Dry-run shows diff; `--apply` writes files; each fix marked `requires-review`; no invented values. |

### 2.2 Agent Observability

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-2.1 | As an AI engineer, I want `shipready observe -- node agent.js` so I see cost, tokens, tool calls, and decisions. | Spawns agent; injects preload; captures LLM calls, tool calls, file ops, network, decisions; writes SQLite trace. |
| US-2.2 | As an AI engineer, I want `shipready observe report` so I get an HTML report with cost breakdown and tool heatmap. | Generates `report.html` with cost chart, token usage, tool frequency, anomalies. |
| US-2.3 | As an AI engineer, I want `shipready observe replay` so I can step through what the agent did. | Interactive TUI or HTML replay showing chronological events with context. |
| US-2.4 | As an AI engineer, I want `--cost-budget 5` so runs abort when cost exceeds threshold. | Tracks running cost; emits anomaly when exceeded; exits non-zero on breach. |

### 2.3 Compliance Documentation

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-3.1 | As a compliance officer, I want `shipready comply init` so I get EU AI Act, GDPR, CSRD templates. | Generates questionnaire + templates (EU AI Act Annex IV, GDPR ROPA/DPIA, CSRD, NIS2, SOC2). |
| US-3.2 | As a compliance officer, I want `shipready comply scan .` so personal data in code is detected. | Scans code for PII patterns; outputs gaps against questionnaire answers. |
| US-3.3 | As a compliance officer, I want `shipready comply generate` so answers produce a full doc pack. | Generates Markdown/JSON/DOCX pack with gap report per document; only version record stored in dashboard. |

### 2.4 E-Invoice Validation

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-4.1 | As a finance team, I want `shipready validate invoice.xml --fix` so NFS-e/NF-e invoices are validated and corrected. | Validates CNPJ/CPF check digits, ISS tax codes, arithmetic, duplicates; `--fix` corrects provable errors only. |
| US-4.2 | As a finance team, I want `shipready convert invoice.xml --to csv` so invoices are importable. | Outputs CSV with all line items, totals, tax breakdown. |

### 2.5 CI Integration

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-5.1 | As a DevOps engineer, I want the GitHub Action so PRs are scored automatically. | `uses: shipreadyai/shipready@v1` with `threshold`, `baseline`, `sarif-output`; posts PR comment; uploads SARIF. |
| US-5.2 | As a team lead, I want `--fail-on blocker` so only launch blockers fail the build. | Exit 1 only on blockers; exit 0 on degradations/cosmetic. |

### 2.6 Dashboard

| ID | Story | Acceptance Criteria |
|----|-------|---------------------|
| US-6.1 | As a stakeholder, I want `pnpm desktop` so I see readiness trends, agent cost, compliance status, invoices. | Launches Next.js dashboard; seeds demo data; shows score history, category radar, agent cost table, compliance packs, invoice table. |
| US-6.2 | As a stakeholder, I want API endpoints so I can build custom views. | REST endpoints: `/api/scan`, `/api/findings`, `/api/trends`, `/api/observe/traces`, `/api/validate-invoice`, `/api/comply/generate`, `/api/health`; all authenticated + rate limited. |

---

## 3. Functional Requirements

| FR | Description | Priority |
|----|-------------|----------|
| FR-1 | Scan engine detects 82 readiness rules + 8 AI-security rules | P0 |
| FR-2 | Rules weighted by category; blockers separate from degradations | P0 |
| FR-3 | SARIF 2.1.0 output compatible with GitHub Code Scanning | P0 |
| FR-4 | `--fix` generates 10 fix types (error middleware, health probes, Dockerfile, etc.) | P0 |
| FR-5 | Observer captures LLM calls, tools, files, network, decisions, errors | P0 |
| FR-6 | Observer stores traces in SQLite; exports HTML/JSON | P0 |
| FR-7 | Compliance covers EU AI Act, GDPR, CSRD, NIS2, SOC2 | P0 |
| FR-8 | E-invoice validates Brazil NFS-e/NF-e (CNPJ, ISS, arithmetic) | P0 |
| FR-9 | GitHub Action posts PR comment + uploads SARIF | P0 |
| FR-10 | Dashboard shows trends, radar, cost table, compliance packs, invoices | P0 |
| FR-11 | All API routes authenticated + rate limited | P0 |
| FR-12 | Self-scan (`shipready scan .`) runs in CI | P0 |

---

## 4. Non-Functional Requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| **Performance** | 60k lines ≤ 5 s cold | `docs/investor/bench.mjs` |
| **Scalability** | Sub-linear per-line cost | `performance.test.ts` |
| **Reliability** | 615 tests pass in CI | `pnpm -r test` |
| **Security** | CSP/HSTS, auth, rate limit, audit, CodeQL | CI gates |
| **Portability** | Node 20.10+, Linux/macOS/Windows | CI matrix |
| **Maintainability** | 615 tests, strict TS, strict lint | CI gates |
| **Extensibility** | Rule plugin system (YAML packs) | Rule catalogue test |
| **Auditability** | Every finding cites provision; `verify-claims.mjs` re-derives numbers | CI gate |

---

## 5. Out of Scope

- Tax authority clearance (e-invoicing)
- Legal advice (compliance docs are templates)
- Hosted SaaS (dashboard is self-hosted)
- Python/Go/Ruby scanners (Node/TypeScript only)
- Real-time collaboration on dashboard

---

## 6. Acceptance Criteria Summary

| Feature | Verification Method |
|---------|---------------------|
| CLI commands | `pnpm -r test` (80 CLI tests) |
| Scanner accuracy | Adversarial fixtures (vulnerable vs. ready) in `core/tests/fixtures.ts` |
| SARIF validity | GitHub Code Scanning accepts upload |
| Observer accuracy | Mock agent emits known events; trace matches |
| Compliance templates | Generated docs pass gap report |
| E-invoice | Brazilian test fixtures (valid + invalid) pass |
| GitHub Action | PR comment + SARIF upload on test repo |
| Dashboard API | All 7 endpoints return 200 with auth + rate limit |
| Self-scan | `pnpm verify:release` passes in CI |

---

## 6. Glossary

| Term | Definition |
|------|------------|
| **Blocker** | Finding that loses data, money, or trust; stops launch |
| **Degradation** | Quality issue; doesn't stop launch but should be fixed |
| **Cosmetic** | Style/nit; doesn't affect correctness |
| **SARIF** | Static Analysis Results Interchange Format 2.1.0 |
| **NFS-e** | Nota Fiscal de Serviços Eletrônica (Brazil service invoice) |
| **ROPA** | Record of Processing Activities (GDPR Art. 30) |
| **DPIA** | Data Protection Impact Assessment (GDPR Art. 35) |

---

**End of Specification**