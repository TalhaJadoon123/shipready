# ShipReady Spec Kit Agent

**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025-10-11  

---

## Agent Definition

This agent implements the Spec Kit workflow for the ShipReady project. It provides three commands that operate on the `.specify/` artifacts:

- `/speckit.clarify` — Find and resolve ambiguities in spec/plan/tasks
- `/speckit.checklist` — Run the machine-verifiable checklist
- `/speckit.analyze` — Cross-artifact consistency check (spec ↔ plan ↔ tasks ↔ implementation)

---

## Agent Capabilities

### 1. Clarify (`/speckit.clarify`)

**Purpose:** Find unresolved ambiguities in spec, plan, and tasks.

**Input:** None (reads `.specify/spec.md`, `.specify/plan.md`, `.specify/tasks.md`)

**Process:**
1. Read all `.specify/*.md` files
2. Search for markers: `NEEDS CLARIFICATION`, `TBD`, `XXX`, `FIXME`, `???`
3. Search for underspecified requirements (e.g., "fast" without numbers, "secure" without threat model)
4. Output structured report with file, line, context, and suggested clarification

**Output Format:**
```markdown
## Clarification Report

### Spec Ambiguities
- `.specify/spec.md:45` — "fast scan" → specify ms target (e.g., "≤500ms for 400 lines")
- `.specify/spec.md:78` — "secure" → define threat model (OWASP Top 10? SOC2?)

### Plan Ambiguities
- `.specify/plan.md:112` — "Turborepo" → version pinned? (2.11.x)

### Task Ambiguities
- `.specify/tasks.md:T-API-1` — "OpenAPI 3.1 spec" — which endpoints? All 7? Auth routes too?
```

**Exit Codes:**
- `0` = No ambiguities found
- `1` = Ambiguities found (report printed to stdout)
- `2` = Error reading files

---

### 2. Checklist (`/speckit.checklist`)

**Purpose:** Run the machine-verifiable checklist from `.specify/checklist.md`.

**Input:** None (reads `.specify/checklist.md`)

**Process:**
1. Parse `.specify/checklist.md` tables
2. For each row with `Command` and `Expected Exit`:
   - Execute command in repo root
   - Compare actual exit code to expected
3. Aggregate results by category
4. Output summary with PASS/FAIL counts

**Output Format:**
```markdown
## Checklist Execution Report

### BUILD: 3/3 PASS
✅ CHK-BUILD-1: `pnpm verify:build` → exit 0
✅ CHK-BUILD-2: `pnpm clean && pnpm build && node scripts/verify-build.mjs` → exit 0
✅ CHK-BUILD-3: `pnpm pack:all && node scripts/inspect-tarballs.mjs` → exit 0

### TEST: 6/7 PASS, 1 CONDITIONAL
✅ CHK-TEST-1: `pnpm -r test` → exit 0
...
⚠️ CHK-TEST-6: Action tests require GitHub env

### Overall: 35/45 PASS (78%)
```

**Exit Codes:**
- `0` = All implemented checks pass
- `1` = One or more implemented checks fail
- `2` = Error executing commands
- `3` = Checklist file not found or malformed

---

### 3. Analyze (`/speckit.analyze`)

**Purpose:** Cross-artifact consistency verification.

**Input:** Reads all `.specify/*.md` + implementation files

**Process:**
1. **Spec ↔ Plan:** Verify every FR/NFR in `spec.md` has corresponding section in `plan.md`
2. **Plan ↔ Tasks:** Verify every technical decision in `plan.md` has implementing tasks in `tasks.md`
3. **Tasks ↔ Implementation:** Verify `DONE` tasks have corresponding code/tests
4. **Spec ↔ Implementation:** Verify every FR in `spec.md` has at least one test in `packages/*/tests/`
5. **Drift Detection:** Flag any `TODO`/`IN_PROGRESS` tasks older than 30 days

**Output Format:**
```markdown
## Cross-Artifact Consistency Report

### Spec → Plan Coverage
✅ FR-1 (scan engine) → Plan §2.1 (Engine)
✅ FR-2 (weighted scoring) → Plan §2.1 (Scoring)
❌ FR-13 (WebSocket support) — No plan section (Out of Scope in Spec)

### Plan → Tasks Coverage
✅ Decision: Turborepo → T-CI-1 (CI uses Turborepo)
❌ Decision: CSP nonce → T-OBSV-4 (TODO)

### Tasks → Implementation
✅ T-CORE-1 (82 rules) → `packages/core/src/scanners/readiness/` (82 files)
✅ T-CLI-1 (6 commands) → `packages/cli/src/program.ts` (6 commands)
❌ T-API-1 (OpenAPI) — No implementation found

### Spec → Tests Coverage
✅ FR-1 (scan) → 281 core tests + 80 CLI tests
❌ FR-14 (WebSocket) — No tests (Out of Scope)

### Drift Detection
⚠️ T-API-1 (OpenAPI) — P1, TODO for 45 days
⚠️ T-OBSV-1 (Logger) — P1, TODO for 32 days
```

**Exit Codes:**
- `0` = No drift, full coverage
- `1` = Drift detected or coverage gaps (report printed)
- `2` = Error reading files

---

## Agent Configuration

```yaml
# .github/agents/spec-kit.yml (for GitHub Actions integration)
name: "ShipReady Spec Kit Agent"
description: "Runs Spec Kit clarify/checklist/analyze commands"
permissions:
  contents: read
  issues: write
  pull-requests: write

commands:
  clarify:
    description: "Find ambiguities in spec/plan/tasks"
    prompt: ".github/prompts/spec-kit-clarify.md"
    permissions: { contents: read }
  
  checklist:
    description: "Run machine-verifiable checklist"
    prompt: ".github/prompts/spec-kit-checklist.md"
    permissions: { contents: read, checks: write }
  
  analyze:
    description: "Cross-artifact consistency check"
    prompt: ".github/prompts/spec-kit-analyze.md"
    permissions: { contents: read, issues: write }
```

---

## Integration with CI

Add to `.github/workflows/ci.yml`:

```yaml
  spec-kit:
    name: Spec Kit Quality Gates
    runs-on: ubuntu-latest
    needs: verify
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run Spec Kit Checklist
        run: |
          # Install spec-kit CLI or use inline script
          node .github/scripts/spec-kit-checklist.mjs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Agent Rules (Constitution-Aligned)

1. **Read constitution first** — Every invocation starts with `.specify/constitution.md`
2. **Additive only** — Never modify existing files; only create new artifacts
3. **Evidence-based** — Every claim cites file paths, line numbers, command output
3. **Human review required** — All outputs flagged "Human review required"
4. **Fail fast** — Exit non-zero on any ambiguity/failure/drift
4. **Traceable** — Every output references spec/plan/tasks IDs

---

**End of Agent Definition**