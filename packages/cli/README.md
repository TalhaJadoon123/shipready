# @shipready/cli

Production readiness for AI-built code. 90 checks, one weighted score, and the
specific things that would lose you data, money or trust before your users find
them.

```bash
npx shipready scan .
#   NOT READY   62/100 (D+)   11 launch blockers
#   1. No rate limiting on API endpoints          HIGH   ~about 1 hours
#   2. Silent catch block swallows the error      HIGH   ~about 15 minutes
#   3. Query with no limit or pagination          MEDIUM ~about 20 minutes
```

## Install

```bash
npm install -g @shipready/cli
# or, per project
npm install -D @shipready/cli
```

Node 20.10 or newer. The observer pulls in `better-sqlite3`, which builds native
code — on a machine without a toolchain, use `--ignore-scripts` and expect
`shipready observe` to be unavailable until you build it.

## Commands

| | |
|---|---|
| `scan [path]` | Scan for production readiness |
| `fix [path]` | Generate working code for the findings that have safe fixes |
| `check [path]` | Fail on a threshold or a blocker. Built for CI |
| `observe -- <cmd>` | Run an agent under observation: cost, tokens, tool calls, errors |
| `comply init` | Scaffold a compliance questionnaire |
| `comply generate` | Generate a documentation pack for the frameworks in scope |
| `validate <file>` | Validate an e-invoice against its country schema |
| `convert <file>` | Convert an e-invoice between formats |
| `rules` | List the readiness checks, optionally by category |
| `init` | Wire up the CI workflow, config file and npm scripts |
| `report` | Re-render the last saved scan without re-running it |

## Exit codes

The same three everywhere, so a script can branch on them:

| | |
|---|---|
| `0` | passed |
| `1` | threshold not met, or a launch blocker found |
| `2` | could not run — bad path, missing file, unparseable input |

## CI

```yaml
- uses: shipreadyai/shipready@v0.1.0
  with:
    path: .
    threshold: 70
    fail-on: blocker   # blocker | any | never
```

Other inputs: `baseline` (only fail on regressions against a stored baseline),
`baseline-file`, `format`, `output`, `sarif-output`, `comment`, `annotations`,
`working-directory`, `token`.

Runs the scan, comments the blockers on the PR, and uploads SARIF so the
findings appear in GitHub's code scanning tab.

## Ignoring findings

Inline, in the code:

```js
// shipready-disable-next-line readiness/security/wildcard-cors
app.use(cors({ origin: '*' }));
```

Or in `.shipready.yml`, which `shipready init` creates:

```yaml
scan:
  threshold: 70
  disable:
    - readiness/testing/no-tests
```

## What it does not do

It does not execute the code it scans. `shipready fix --apply` writes files, so
run `shipready fix --dry-run` first. `shipready observe -- <command>` does
execute the command you give it — point it at something you trust.

## Licence

MIT. See the [repository](https://github.com/shipreadyai/shipready) for the rule
catalogue, the accuracy work, and how to report a vulnerability.