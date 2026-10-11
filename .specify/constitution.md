# ShipReady Constitution

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  

---

## Purpose

This constitution codifies the principles, standards, and guardrails that govern the ShipReady project. It serves as the supreme reference for all contributors—human and AI—and ensures every decision aligns with the project's mission: **delivering a production-readiness layer for AI-built software that is honest, auditable, and actionable.**

Any change to this constitution requires explicit human approval and a version bump.

---

## I. Mission & Scope

**Mission:** Answer "Is this ready for real users?" with evidence, not vibes.

**Scope:**
- Production-readiness scanning (82 rules across 10 categories + 8 AI-security rules)
- Agent observability (cost, tokens, tools, decisions, replay)
- Compliance documentation (EU AI Act, GDPR, CSRD, NIS2, SOC2)
- E-invoice validation (Brazil NFS-e/NF-e)
- GitHub Action integration
- Dashboard for trends, cost, compliance, invoices

**Out of Scope:**
- Tax authority clearance (e-invoicing)
- Legal advice (compliance docs are templates, not counsel)
- Hosted SaaS (dashboard is self-hosted only)

---

## II. Technology Standards

| Layer | Standard | Rationale |
|-------|----------|-----------|
| **Runtime** | Node.js ≥ 20.10 (ESM) | Modern stdlib, native fetch, top-level await |
| **Language** | TypeScript 5.7 (strict) | Type safety catches regressions; `noEmit` typecheck in CI |
| **Package Manager** | pnpm 9.x (workspaces) | Disk efficiency, strict resolution, workspace protocol |
| **Build** | Turborepo 2.x | Incremental builds, remote caching, task pipeline |
| **Testing** | Vitest 2.x (fork pools) | Parallel, isolated, flake-resistant |
| **Linting** | ESLint 9 (flat config) + Prettier 3 | Consistent style, catch bugs early |
| **Database** | Drizzle ORM + Postgres (prod), PGlite (dev), file-backed memory (default) | Type-safe SQL, zero-config dev, no external deps for local work |
| **Native Deps** | better-sqlite3 (observer) | Compiled at install; rebuilt per Node version |

**Non-Negotiable:**
- All packages declare `"type": "module"` and `"engines": { "node": ">=20.10.0" }`
- No `any` in production code (use `unknown` + narrowing)
- No `eval`, `Function`, `child_process.execSync` in scanner code
- All async functions return `Promise<T>` explicitly

---

## III. Security Requirements

| Requirement | Implementation |
|-------------|----------------|
| **No hardcoded secrets** | `.env.example` documents all vars; `docker-compose.yml` uses `${VAR}`; `SECURITY.md` defines trust boundaries |
| **Input validation** | Zod schemas on all API routes (`api-schema.ts`); path traversal guard (`isScannablePath`) |
| **Authentication** | Dashboard: Bearer token + cookie middleware (`SHIPREADY_DASHBOARD_TOKEN`); skipped in dev |
| **Rate limiting** | Per-endpoint in-memory limiter (stricter for AI endpoints); applied to all 7 API routes |
| **Headers** | CSP (strict), HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy |
| **Dependency audit** | `pnpm audit --prod --audit-level high` in CI; CodeQL security-extended weekly |
| **Supply chain** | Lockfile committed; `pnpm install --frozen-lockfile`; no post-install scripts except better-sqlite3 |

**Prohibited:**
- Writing secrets to reports, traces, or dashboard records
- Executing scanned code (scanner is read-only)
- Deploying dashboard without `SHIPREADY_DASHBOARD_TOKEN`

---

## IV. Performance Expectations

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cold scan (400 lines)** | ≤ 500 ms | `node docs/investor/bench.mjs` |
| **Cold scan (12k lines)** | ≤ 1 s | Same |
| **Cold scan (60k lines)** | ≤ 5 s | Same |
| **Per-line cost** | Flat (sub-linear) | Quadratic regressions caught by `performance.test.ts` |
| **Memory** | < 500 MB for 60k lines | Stream processing, no full-tree in memory |

**Guardrails:**
- `performance.test.ts` fails on regression (line-access caching memoized in `source.ts`)
- No per-line loops that re-split content (`buildLineIndex` memoized)
- Streaming file reads, not full-tree loads

---

## V. Coding Conventions

| Convention | Rule |
|------------|------|
| **Formatting** | Prettier 3 (printWidth 100, single quotes, semi, trailing comma) |
| **Imports** | ESM only (`import`/`export`); `.js` extensions required in source |
| **Types** | Explicit return types on all exported functions; `unknown` over `any` |
| **Errors** | Never swallow; return `Result<T, E>` or throw with context |
| **Logging** | Structured JSON (when logger added); request IDs; no PII |
| **Tests** | AAA pattern; adversarial fixtures (vulnerable vs. production-ready); false-positive guards required for every rule |
| **Naming** | `kebab-case` for rule IDs (`readiness/security/no-cors`); `PascalCase` for types; `camelCase` for vars |
| **Git** | Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`); messages explain *why*, not *what* |

---

## VI. Compliance Needs

| Framework | Coverage |
|-----------|----------|
| **EU AI Act** | Annex IV, risk classification, human oversight, post-market monitoring, conformity declaration |
| **GDPR** | ROPA, DPIA, rights procedures, lawful basis, data categories |
| **CSRD** | Materiality (double), GHG worksheet, value chain, reporting period |
| **NIS2** | Cybersecurity practices, incident reporting, supply chain |
| **SOC2** | Security practices (CC6.1+) |
| **EN 16931** | E-invoice structure (Brazil NFS-e/NF-e) |

**Rule Requirement:** Every finding cites its provision (article, control, CWE, OWASP). No "vibe" findings.

---

## VII. AI-Agent Alignment

This constitution is the primary context for AI agents working on ShipReady. Agents MUST:

1. **Read this file first** before any task.
2. **Never modify** existing files without explicit human instruction (audit mode).
3. **Write only additive files** (new artifacts, never modifications).
4. **Verify claims** with evidence (file paths, line numbers, command output).
5. **Run `pnpm verify:build`** before proposing changes.
6. **Run `pnpm -r test`** before proposing changes.
7. **Document evidence** in reports (file paths, line numbers, commands).

**Agent Commands Defined:**
- `/speckit.clarify` → `.github/prompts/spec-kit-clarify.md`
- `/speckit.checklist` → `.github/prompts/spec-kit-checklist.md`
- `/speckit.analyze` → `.github/prompts/spec-kit-analyze.md`

---

## VIII. Amendment Process

1. Propose amendment in a PR with `constitution:` prefix.
2. Human reviewer verifies alignment with mission and principles.
3. Approve → merge → version bump (semver: MAJOR for principle changes, MINOR for additions, PATCH for clarifications).
4. Update `constitution.md` version header.

---

**End of Constitution**