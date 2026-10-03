# Launch checklist

Everything between "the code works" and "someone can `npm install -g
@shipready/cli`". Ordered, with the reason each step is where it is.

Status as of the last run: **step 1 done, everything else outstanding.**

---

## 1. Repository hygiene — DONE

- [x] `LICENSE` (MIT) — npm requires it; it was missing entirely
- [x] `SECURITY.md` — disclosure path and the trust boundaries stated explicitly
- [x] `CONTRIBUTING.md` — including the false-positive discipline that defines
      this project
- [x] `CODE_OF_CONDUCT.md`
- [ ] `CHANGELOG.md` — generate at release, or use `npm version` + a release page
- [ ] `LICENSE` present in **each** published package (root is not enough)
- [ ] `README.md` in each published package that is user-facing

## 2. Verify the package actually installs — BLOCKED

This is the step that has not been done, and it does not work yet.

```
$ npm install @shipready/cli     # or a tarball install
ERR_PNPM_FETCH_404  @shipready/einvoice: Not Found - 404
```

The CLI depends on five workspace packages. On publish, `workspace:*` is
rewritten to the real version, but **all six packages have to exist on npm
first**, in dependency order. Nothing is published yet, so the install fails.

**Verified working locally**, which proves the code is fine and only the
publishing order is missing:

```
$ pnpm --filter @shipready/cli pack        # 62 KB tarball
$ npm install ./shipready-cli-0.1.0.tgz    # with local links for the siblings
$ shipready --version                      # 0.1.0
$ shipready scan .                         # NEEDS WORK  87/100 B, 12 findings
```

To rehearse the real install, add `publishConfig.directory` or point the
workspace deps at local tarballs in a scratch project.

## 3. Publish, in dependency order

`@shipready/*` is unclaimed on npm — check before assuming.

```bash
npm login                              # or: npm token create
cd packages/core      && npm publish --access public --provenance
cd packages/rules     && npm publish --access public --provenance
cd packages/einvoice  && npm publish --access public --provenance
cd packages/compliance&& npm publish --access public --provenance
cd packages/observer  && npm publish --access public --provenance
cd packages/cli       && npm publish --access public --provenance
```

Order matters: `core` and `rules` have no workspace deps; `compliance` and
`einvoice` depend on nothing; `observer` is standalone; `cli` depends on all
five and must go last.

Then verify from a **clean machine**, not this repo:

```bash
npm install -g @shipready/cli
cd ~/some-real-project
shipready scan .
```

## 4. Git remote and first push

There is no remote configured and nothing has ever been pushed.

```bash
git remote add origin git@github.com:<you>/shipready.git
git push -u origin master
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The tag must match the npm version. GitHub releases and npm versions moving
apart is the most common way a JS project loses users' trust.

## 5. CI on the repository itself

- [ ] `.github/workflows/ci.yml` — build, typecheck, test on Node 20/22
- [ ] Run `shipready check .` on PRs, so the tool gates its own repository
- [ ] Score the self-scan honestly. It currently reports **58/100 with 11
      blockers**. Decide: fix them first, or state the number publicly. Either
      is defensible; hiding it is not.

## 6. Landing page and docs site

Both unbuilt. Minimum viable:

- [ ] Landing page: what it does, the 90 rules, a real screenshot, install
- [ ] A 60-second demo video — this outperforms any page for this product
- [ ] `/pricing` — no prices are set yet
- [ ] Docs site: quickstart, the rule catalogue, CI setup, rule authoring
- [ ] Comparison page (Snyk, Semgrep, Cursor, Vanta) — see
      `docs/investor/materials.md` §6

## 7. Marketplace and distribution

- [ ] GitHub Action published as a repo others can reference:
      `uses: shipreadyai/shipready@v0.1.0`
- [ ] README badges: CI, npm version, licence
- [ ] `shipready init --ci` writes a workflow that references the pinned
      version — verify the pin, not `main`

## 8. Operational

- [ ] npm 2FA enabled on the account
- [ ] Provenance publishing configured (`--provenance`, needs a public CI
      workflow in the same commit)
- [ ] Support inbox monitored
- [ ] Issue and PR templates
- [ ] Dependabot for the 8 packages

## 9. Before letting anyone else use the dashboard

Not ready, and stated as such in the README and investor materials:

- [ ] **Authentication.** The dashboard has none. It must not be deployed
      publicly as-is.
- [ ] **The Drizzle/Postgres adapter is not written.** Development uses a
      file-backed store; selecting Postgres today throws a named error. This is
      the single largest engineering gap.
- [ ] Rate limiting on the API routes
- [ ] Decide what is stored server-side. Current stance: compliance documents
      stay on the user's filesystem, traces stay in local SQLite. Confirm that
      is what you want before anyone signs up on the promise of it.

---

## Suggested first milestone

Steps 1–5 only. That gets you a real `npm install -g` working, which is the
point at which you can honestly say the product is live and start asking for
feedback. Steps 6–9 are what turn a released tool into a business, and none of
them matter until step 3 works.