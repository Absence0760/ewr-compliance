# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file short — it loads into every conversation.

EWR Compliance Measurement compares observed river flows with Environmental Water Requirements at the EWR nodes and sites of the Berg, Breede-Overberg, Gouritz and Olifants-Doorn basins. It opens on South Africa's Water Management Areas of 2023, each with its own map. It is a static SvelteKit 3 app (`adapter-static`, `ssr = false`) with Svelte 5 runes and TypeScript. Layout and conventions: `docs/architecture.md`.

**Hosting is on AWS af-south-1,** per the private hosting plan: built in `infra/` (Terraform, `infra/README.md`), `tools/deploy.sh`, `server/`, `static/signin/` and `pipeline/`, not yet applied. Going live is the operator's: `docs/hosting.md` § Deploy readiness. The site sets only strictly necessary cookies (the session and CloudFront's), all from `server/`, and no analytics. **Sign-in, sessions and user management come from `auth-kit`,** a private package `server/` installs at a pinned tag. Don't write auth code here: fix it in `auth-kit`, tag it, and take the Dependabot PR (and bump the `onlyBuiltDependencies` line in `server/pnpm-workspace.yaml` with it).

This repo is public and holds the code. The real data, the client's brief and the tests pinned to them are in the private repo `ewr-compliance-private`, a sibling folder. This repo runs on a synthetic sample.

## Commands

pnpm 10 and Node 24. The app is one package. `server/`, the sign-in API, is a separate pnpm project with its own lockfile (not a workspace member), because it needs read access to the private `auth-kit`; the app, e2e and fork PRs install without it. `pipeline/`, the DWS store's Lambda, is one too.

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | Install |
| `pnpm dev` | Dev server on port 7790 |
| `pnpm build`, `pnpm preview` | Static build into `build/`, and serve it on port 7790 |
| `pnpm check` | `svelte-kit sync` and `svelte-check` |
| `pnpm data:sample` | Copy the synthetic sample to `static/data`. Run it first on a fresh clone. Refuses to replace real data without `--force` |
| `pnpm data:private` | Copy the real data and its tests in from the private repo (`EWR_PRIVATE_DIR` overrides the folder) |
| `pnpm test`, `pnpm test:watch` | Vitest (`src/**/*.test.ts` and `tools/**/*.test.ts`, beside each module), on the sample |
| `cd server && pnpm install --frozen-lockfile`, then `pnpm check`, `pnpm test`, `pnpm build` | The sign-in API: install (needs access to `auth-kit`), typecheck, Vitest, and bundle `dist/api.zip`. CI deploys it on an `api@X.Y.Z` release (`deploy-lambdas.yml`) |
| `cd pipeline && pnpm install --frozen-lockfile`, then `pnpm check`, `pnpm test`, `pnpm build` | The DWS store's pipeline: install, typecheck, Vitest on synthetic `X0H00x` replies (with a contract test against the app's own readers), and bundle `dist/pipeline.zip`. CI deploys it on a `pipeline@X.Y.Z` release |
| `tools/dws-stations.sh [--dry-run]`, `node tools/dws-backfill-plan.mjs --from YYYY-MM-DD` | The operator's: upload the DWS store's station list from the private repo (`tools/deploy.sh real` runs it; it prints a count, never a code), and print the backfill's input (date windows only). `infra/README.md` H11 |
| `tools/first-admin`, `tools/recover-admin`, `tools/clear-lock`, `tools/erase-user` | The operator's, with their AWS profile: the first admin, the break-glass, clearing a sign-in lockout without changing a role, erasure. Each asks for the address |
| `pnpm test:e2e` | Playwright (`e2e/`), on the sample. Needs `pnpm data:sample`. Builds its own servers on ports 7795 and 7796 and refuses to start if either is held (one run at a time per machine) |
| `pnpm test:private` | `pnpm data:private`, then Vitest and Playwright over the real data |
| `python3 ../ewr-compliance-private/tools/build_gauges.py` | Rebuild `gauges.json` and `flows-<station>.json`, the node-to-gauge links and gauge records, in the private repo. Arguments: `README.md` § Rebuild the data |
| `python3 ../ewr-compliance-private/tools/build_node_info.py` | Rebuild `node-info.json`, what the RQO node workbook records at each node (REMP/BM site, EWR site ID, WQ station, SWSAs), in the private repo. Arguments: `README.md` § Rebuild the data |
| `python3 ../ewr-compliance-private/tools/build_data.py`, `python3 tools/build_geo.py` | Rebuild the real data in the private repo, and the quaternaries file it places nodes with. Arguments and dependencies: `README.md` § Rebuild the data |
| `node tools/build-rivers.ts` | Rebuild `static/geo/rivers-<wma>.json`, the named DWS 1:500 000 rivers of each WMA. Network |
| `tools/deploy.sh sample\|real [--dry-run] [--yes]` | Build a clean worktree of `origin/main`, check it (`tools/deploy-check.mjs`), `aws s3 sync` it to the site bucket in two cache passes and invalidate CloudFront. Operator's workstation only, with the `ewr-compliance` SSO profile. Details: `docs/hosting.md` § Build |
| `bin/check-infra.sh` | Terraform fmt, validate and the mocked-provider tests of `infra/` (`infra/tests/`), in a temporary copy, with no AWS credentials. CI's `Terraform` job. Never plan or apply against AWS from a session: that is the operator's (`infra/README.md`) |
| `node tools/check-live-services.ts` | Check the live ArcGIS layers against what the app assumes. Network, by hand |
| `pnpm check:terms`, `pnpm check:claude`, `pnpm check:bundle` | Repo guards: no client term in a tracked file (the list is the private repo's `client-terms.txt`; `.githooks/` run it on every commit, `SECURITY.md` § Public repo hygiene), the agents and commands cite only real paths (CI's `Claude tooling`), and the build's gzipped code stays under its ceilings with maplibre and SheetJS lazy (after `pnpm build`; ceilings in `tools/check-bundle-budget.mjs`) |

## Hard rules

1. **Client-only, except `server/` and `pipeline/`.** `src/` has no server code, SSR adapter, server load function or API key. `server/` is the sign-in and user API only, on `auth-kit`; its keys are read at run time from Secrets Manager, never from the environment or a file. `pipeline/` only pulls DWS's published flow into the store, politely (one request a second, nothing retried after a 403), and writes what the app's own readers accept; station codes never go in this repo, a workflow, a log line beyond a failed page's label, or the backfill's input. A flow file a user loads stays in the browser: nothing sends it anywhere, `server/` and `pipeline/` included. Not signed in is 401, never 403 (CloudFront turns every 403 into the sign-in page).
2. **Everything here is public.** No secret in any file, encrypted or not, and no personal data. No client material either: no real flow or EWR value, node code, site, file name or quoted brief, in code, comments, tests or docs. Fixtures added to tests are synthetic. Real values go in the private repo.
3. **`static/data` is generated and ignored by git.** Never edit it by hand and never force-add it: it may hold real data. Real data is rebuilt into the private repo through `tools/`, and `pnpm test:private` is what can fail for a real reason. The sample comes from `e2e/fixtures/make-sample-data.mjs`: change that, rerun it, and update the specs' hand arithmetic.
4. **Numbers on screen come from `src/lib/ewr`,** never recomputed in a component. `parsers.ts` and `resolve.ts` stay pure: no DOM, no fetch.
5. **Conventions in `docs/architecture.md` hold:** `#lib/...` imports with the extension (`$lib` is removed), paths with no leading slash, runes only, tabs and single quotes.

## Domain rules

The numbers are checked against the brief and a reference compliance workbook, by the tests in the private repo. Get these wrong and the graphic still looks right.

- **Chart line names are exact:** `EWR Monthly Requirement`, `Drought EWR`, `Urgent action required`. The comparisons are "Historical Comparison" and "Real Time Comparison".
- **`DAYS` uses 28 for February** (`src/lib/ewr/parsers.ts`), the same as the reference workbook, in every Mm3 to m3/s conversion of an EWR. Don't correct it for leap years. Observed m3/s converts over real calendar days (`daysIn`).
- **The `.tab` columns used** are Low Flows Drought (the 5th data column, the `Drought EWR` line) and Total Flows Maint. (the last column, the `EWR Monthly Requirement` line).
- **Revised `.rul` reading uses the Present Day section,** the one headed "EWR (low and total Flows) are constrained to be below Present Day Flows", not the Natural one. The header text is the same in both, so the section decides.
- **File name vs header EC conflicts are resolved by `../ewr-compliance-private/tools/build_data.py`** (`resolve_ec_conflicts`), by comparing values with the sibling run. Never by trusting the name or the header alone, and never in the app.
- **A month flagged `#` in DWS data is left out of every mean,** whatever figure it carries, as the client specified. It is still shown, marked, in a gauge's record. A blank month counts the same.
- **A monthly table worked up from a daily file can hide gaps.** `+` is a patched value and counts. `-99.999`, and every unpatched month the daily record shows is not whole (`incomplete` in `gauges.json`), are left out. Its `0.000` can mean no data.
- **In daily flow, code 170 or a blank is missing and is never drawn.** Codes 1 and 2 are clean. Any other code is a real value, patched or unreliable, and is drawn in its own colour (`isCoded`).
- **The factor on a node's gauge record comes from outside the app.** Never derive it here. It scales the node's observed flow, in both comparisons, never the gauge's own record.
- `Urgent action required` is 10% below `EWR Monthly Requirement`, for both the `.tab` and Revised methods (the brief lists it under Revised only; this is a project decision). Defaults: TEC for the EC, the 50th percentile for `EWR Monthly Requirement`, the 90th for `Drought EWR` (the 99th is the option).

## Working alongside other Claude sessions

Several Claude sessions may share this checkout, its working tree and its git index. `.claude/hooks/git-scope-guard.py` enforces these rules; if it denies a command, use the scoped alternative its message names.

- **Every change reaches `main` through a PR; never push or commit on `main`.** Branch protection requires it, admins included, with `CI gate` green and linear history (squash or rebase). Work in a worktree off `origin/main`, one per PR branch. Run `pnpm check`, `pnpm test` and `pnpm test:e2e` before pushing. Don't merge your own PR unless the operator asks. No `Co-Authored-By` or generated-by trailer in commits or PR bodies.
- **PR titles are conventional commits:** `<type>(<scope>): <subject>`, type one of feat, fix, chore, docs, refactor, test, perf, ci, build, revert; the subject starts lowercase and doesn't end with a period. CI's `pr-title-lint` fails anything else, and the hook refuses such a `gh pr create/edit --title`.
- **Commit path-scoped, always:** `git commit -m "…" -- <paths>`. Bare `git commit`, `git add -u/-A/.`, `git commit -a` and `--amend` with staged changes are blocked.
- **Only touch what your task owns**, and never whole-tree: no `git add .`, `checkout/restore .`, `reset --hard`, `git rm .`, `git stash`, `git clean -f`.
- **HEAD moves under you.** Commits you didn't make and files you didn't change are other sessions' work; leave them. Update a PR branch that falls behind by merging `origin/main`, not rebasing.

## Code organization

- No preemptive abstraction: extract on the third caller. A bug fix doesn't smuggle in a refactor.
- Group `src/lib`, `.claude/agents/` and `.claude/commands/` by topic; co-locate each unit test beside its module.

## Every code change updates tests + docs in the same change

1. Add or update tests for what you touched. If something is genuinely untestable (config, pure styling), say so explicitly.
2. Update the relevant doc if the change affects architecture, commands, data or features: `docs/architecture.md`, `README.md`, this file. A one-line doc edit is still an edit.

Treat "code changed, docs and tests unchanged" as an incomplete task. Flag it before handing back.

## Fix bugs at the source

When a test fails, either the test is broken (fix the test) or the app is (fix the app). There is no third option. Forbidden, because they ship the bug behind a green check: an inflated timeout, `waitForTimeout`, retries, `test.skip`/`fixme` against a real bug without a tracked follow-up, a loosened assertion or a widened tolerance. The same goes outside tests: no swallowed errors, no `try/catch` that hides a failure.

A real issue you surface gets driven to resolution: fix it now when it's bounded, otherwise raise a tracked issue (confirm before creating one) naming what's broken and the durable fix. When a quick patch and a durable fix diverge, name the durable fix.

## UI verification

Don't spin up the dev server to verify UI changes before reporting a task complete. `pnpm check` and `pnpm test` are sufficient; the operator reviews visuals. Only run it if asked.

## Claude tooling

Agents live in `.claude/agents/` by team, commands in `.claude/commands/`. The index is `.claude/README.md`. The ones to reach for:

- `/issue <n>` — work one GitHub issue end to end: worktree, route, `/check`, PR.
- `/draft` — ad hoc testing: one draft PR, each issue the operator sends fixed into it, `/draft ready` to finish.
- `/check` — pre-commit gate over the diff (review, test gaps, doc gaps; `ewr-reviewer` and UI review when those are touched).
- `/safe-edit` — reviewer loop for load-bearing changes.
- `/polish-ui` — build or review one screen.
- `/audit/<area>`, `/audit/all`, `/persona`, `/release-readiness` — periodic sweeps and the pre-release gate.

## Where to look

`docs/architecture.md` for the layout, `CONTRIBUTING.md` for how a change lands and a release deploys, `README.md` for the sample, the data rebuild and the data sources, `docs/hosting.md` for what a deployment needs. In the private repo: `../ewr-compliance-private/docs/requirements.md` for what was asked, `../ewr-compliance-private/docs/data-review.csv` for every join and correction a person should check.
