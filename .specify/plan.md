# ShipReady Technical Plan

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  
**Constitution Check:** ✅ Passed (see `constitution.md`)  

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        ShipReady CLI                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  scan    │ │ observe  │ │ comply   │ │ validate/convert │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │
└───────┼─────────────┼─────────────┼──────────────┼────────────┘
        │             │             │              │
        ▼             ▼             ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    @shipready/core                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Registry │ │ Engine   │ │ Scanners │ │  Autofix / Fix    │  │
│  │ (Rules)  │ │ (Walk)   │ │ (90)     │ │  (10 types)      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │             │             │              │
        ▼             ▼             ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Shared Dependencies                            │
│  @shipready/rules (YAML)  │  yaml  │  vitest  │  typescript    │
└─────────────────────────────────────────────────────────────────┘
```

**Key Principle:** The core scanning engine is pure TypeScript with no external service dependencies. All I/O is abstracted through the `SourceFile` / `ProjectContext` interfaces so scanners are pure functions.

---

## 2. Data Model

### 2.1 Core Types (`packages/core/src/types.ts`)

```typescript
// Finding — the atomic unit of a scan result
interface Finding {
  ruleId: string;           // e.g., "readiness/security/no-cors"
  title: string;            // Human-readable
  severity: 'critical'|'high'|'medium'|'low'|'info';
  impact: 'blocker'|'degradation'|'cosmetic';
  confidence: number;       // 0–1
  effortMinutes: number;    // Estimated fix time
  fixable: boolean;         // Can `shipready fix` generate it?
  path: string;             // File path
  line: number;             // Line number
  snippet: string;          // Code excerpt
  evidence: string;         // Why this fired
  data?: Record<string, unknown>; // Structured extras
}

// ProductionReadinessReport — scan output
interface ProductionReadinessReport {
  score: number;                    // 0–100 weighted
  grade: 'A'|'B'|'C'|'D'|'F';
  verdict: 'PRODUCTION READY'|'READY WITH CAVEATS'|'NEEDS WORK'|'NOT READY';
  summary: {
    totalFindings: number;
    blockers: number;
    degradations: number;
    cosmetic: number;
    fixable: number;
    estimatedTimeToLaunch: string;
    bySeverity: Record<string, number>;
    byImpact: Record<string, number>;
    byCategory: Record<string, number>;
  };
  categories: CategoryScore[];
  findings: Finding[];
  topBlockers: Finding[];           // Capped at 5
  project: ProjectInfo;
  generatedAt: string;
}
```

### 2.2 Dashboard Entities (`packages/web/src/db/schema.ts`)

```typescript
// Scans — historical readiness scores
scan: { id, projectId, score, grade, verdict, blockers, findingsCount, createdAt }

// Findings — denormalized for filtering
finding: { id, scanId, ruleId, severity, category, path, line, effortMinutes, fixable }

// Traces — agent observability summaries
trace: { id, projectId, command, startedAt, durationMs, exitCode, totalCostUsd, llmCalls, toolCalls, errors }

// Compliance — version records (not documents)
compliance: { id, projectId, company, systemName, jurisdiction, frameworks, score, gaps, documentCount }

// Invoices — validation history
invoice: { id, projectId, country, documentType, number, issuer, total, currency, valid, score, issues }
```

---

## 3. Interface Contracts

### 3.1 CLI Commands (`packages/cli/src/program.ts`)

| Command | Arguments | Options | Exit Codes |
|---------|-----------|---------|------------|
| `scan [path]` | `path` (default `.`) | `-f, --format`, `-o, --output`, `-t, --threshold`, `--compare`, `--baseline`, `--fail-on`, `--disable`, `--enable`, `--min-severity`, `--min-confidence`, `--include`, `--exclude`, `--max-files`, `--annotations`, `--verbose`, `--full`, `--max-findings` | 0=ok, 1=threshold/baseline fail, 2=error |
| `fix [path]` | `path` | `--apply`, `--dry-run` | 0=ok, 1=fixes applied, 2=error |
| `observe -- <cmd>` | command string | `--cost-budget`, `--cost-per-event`, `--capture-content`, `--timeout`, `--db-path`, `--quiet`, `--json` | Agent exit code |
| `observe report|replay|compare|list|cost` | subcommand | `--db-path`, `--limit`, `--json`, `--output` | 0=ok, 2=error |
| `comply init|scan|generate` | subcommand | `--format`, `--output` | 0=ok, 2=error |
| `validate|convert <file>` | file path | `--fix`, `--to`, `--output` | 0=ok, 1=invalid, 2=error |

### 3.2 Dashboard API (`packages/web/src/app/api/*`)

| Endpoint | Method | Auth | Rate Limit | Description |
|----------|--------|------|------------|-------------|
| `/api/scan` | POST (upload) / PUT (scan) | Bearer/cookie | 60/min | Upload CLI report or trigger scan |
| `/api/findings` | GET | Bearer/cookie | 120/min | Filtered findings list |
| `/api/trends` | GET | Bearer/cookie | 120/min | Score history + radar |
| `/api/observe/traces` | POST/GET | Bearer/cookie | 30/min | Upload/list traces |
| `/api/validate-invoice` | POST/GET | Bearer/cookie | 30/min | Validate/convert + history |
| `/api/comply/generate` | POST/GET | Bearer/cookie | 20/min | Generate/list packs |
| `/api/health` | GET/OPTIONS | None | 120/min | Driver + version |

### 3.3 GitHub Action Inputs

```yaml
inputs:
  path: '.'                    # Path to scan
  threshold: 50                # Fail below score
  baseline: false              # Regression-only mode
  fail-on: 'blocker'           # blocker|any|never
  format: 'github'             # console|json|markdown|sarif|html|github|summary
  output: ''                   # Output file
  sarif-output: ''             # SARIF file path
  comment: true                # Post PR comment
  annotations: true            # GitHub annotations
  baseline-file: ''            # Custom baseline path
```

---

## 4. Technical Decisions

| Decision | Rationale | Constitution Reference |
|----------|-----------|------------------------|
| **Turborepo monorepo** | Incremental builds, task pipeline, remote caching | Tech Standards |
| **pnpm workspaces** | Disk efficiency, strict resolution, `workspace:*` protocol | Tech Standards |
| **ESM only** | Modern standard, native `import`/`export`, no dual-package hazard | Tech Standards |
| **TypeScript strict** | Catches regressions at compile time | Tech Standards |
| **Vitest fork pools** | Isolated tests, no worker-thread flakes | Testing |
| **Drizzle ORM** | Type-safe SQL, no runtime overhead | Tech Standards |
| **better-sqlite3** | Fast embedded SQLite for observer traces | Tech Standards |
| **PGlite fallback** | Zero-config dev database (WASM SQLite) | Tech Standards |
| **File-backed memory store** | Zero-config dev, data survives restart | Tech Standards |
| **Zod for validation** | Runtime + compile-time schema safety | Tech Standards |
| **Commander.js** | Mature CLI framework, TypeScript support | Tech Standards |
| **Next.js 15 App Router** | Server components, streaming, middleware | Tech Standards |
| **React 19** | Concurrent features, server components | Tech Standards |
| **YAML rule packs** | Declarative, CC0, non-programmer editable | Compliance Needs |
| **Zod for env validation** | Single source of truth, fail-fast | Config (P1-6) |

---

## 5. Research Decisions (Resolved)

| Question | Decision | Evidence |
|----------|----------|----------|
| **Scanner: AST vs. regex?** | Regex on masked source (comments/strings removed) | 40x faster than AST; `source.ts` memoizes line index |
| **Observer: preload vs. wrapper?** | `--require` preload intercepts globals (`fetch`, `fs`, `child_process`) | Zero code changes to agent |
| **Dashboard auth: session vs. token?** | Shared secret token (Bearer/cookie) — simple, no session store | Security Requirements |
| **Rate limit: memory vs. Redis?** | In-memory per-process (single-instance); Redis for multi-instance (P1) | Tech Standards |
| **Compliance docs: store or generate?** | Generate on demand; store only version record (score, gaps) | Compliance Needs |
| **E-invoice: clearance?** | Explicitly out of scope — validation only | Scope |
| **Self-scan in CI** | Yes — `shipready scan .` runs on every push | NFR |

---

## 6. Migration Strategy (If Applicable)

Not applicable — greenfield project. Future migrations (e.g., Next.js 16, React 20) will follow:
1. Document in ADR (`docs/adr/`)
2. Spike in branch with `pnpm verify:release` passing
3. Update constitution if tech standards change
4. Merge via PR with `constitution:` prefix if standards change

---

## 7. Constitution Check

| Principle | Status | Evidence |
|-----------|--------|----------|
| Tech Standards | ✅ | Turborepo, pnpm, TS strict, ESM, Vitest |
| Security | ✅ | CSP, HSTS, auth, rate limit, audit, CodeQL |
| Performance | ✅ | Sub-linear scan, memoized line index, bench |
| Coding Conventions | ✅ | Prettier, ESLint flat, strict TS, conventional commits |
| Compliance | ✅ | EU AI Act, GDPR, CSRD, NIS2, SOC2, EN 16931 |
| AI-Agent Alignment | ✅ | This plan references constitution; agents read it first |

---

**End of Plan**