---
name: steward
description: How to drive a pull request in this repo to green and mergeable — reading CI, reproducing each job locally, what counts as a flake, updating a branch that fell behind, answering reviews, and when to ask the operator. Use when watching, fixing or babysitting a PR here.
---

# Steward: driving a PR to green

Repo-specific conventions for a session that owns or watches a PR. The root `CLAUDE.md` rules still apply; this adds how CI here behaves and what to do about it.

## Read the PR first

On every wake, look at the whole PR on its current head: merge state, the `CI gate` check, every open review thread. `CI gate` (the `ci-gate` job in `.github/workflows/ci.yml`) is the one required check: it fans in on every job and is green only when none failed. A red `CI gate` names the upstream job that failed; that job is the thing to fix.

Branch protection on `main` (`CONTRIBUTING.md`) requires `CI gate` green, every review conversation resolved, and a squash or rebase merge (linear history). Nothing else is required: CodeQL, Scorecard and the labeler report but never block, so a merge state of `UNSTABLE` while they run is not a block. `BLOCKED` means `CI gate` or a conversation; `BEHIND` never blocks here (the check isn't strict).

`pr-mergeable` failing means GitHub couldn't build a merge ref (a conflict), so **ci.yml didn't run at all**: green-looking PR checks from the other workflows prove nothing. Resolve the conflict first.

## Docs-only and draft PRs

The `changes` job decides whether anything besides `docs/`, `.claude/` and `*.md` changed, and a draft counts as no. If not, the `test` and `e2e` jobs are skipped (skipped counts as passing). Jobs that still run: `claude-tooling`, `gitleaks`, and the `pull_request_target` workflows (`pr-title-lint`, `labeler`, `pr-mergeable`).

## Reproduce a failed job locally

Run the same command the job runs.

| Job | Locally |
|---|---|
| Typecheck, unit tests and build (`test`) | `pnpm check`, `pnpm test`, `pnpm build` |
| E2E tests (`e2e`) | `pnpm test:e2e > e2e.log 2>&1` (never piped into `grep` or `head`: it can hang) |
| Claude tooling (`claude-tooling`) | `python3 .claude/hooks/git-scope-guard.test.py`, then `node tools/check-claude-tooling.mjs` |
| Bundle budget (a step of `test`) | `pnpm build && pnpm check:bundle` |
| Server (`server`) | `cd server && pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build` (needs access to auth-kit; CI skips with a warning until `AUTH_KIT_READ_TOKEN` exists) |
| Pipeline (`pipeline`) | `cd pipeline && pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build` |
| Terraform (`terraform`) | `bin/check-infra.sh` |
| gitleaks | the finding names the file and rule; remove the secret and treat it as leaked (rotate), never allowlist a real one |
| `pr-title-lint` | the title is `type(scope): lowercase subject` with no trailing period |

Read the failure first: `gh run view <run> --log-failed`. An e2e failure uploads `playwright-results` as an artifact: `e2e/test-results/` (traces) and `e2e/playwright-report/`, for `gh run download <run> -n playwright-results`.

## Flakes

"Flake" is not a root cause. A test that fails once and passes on a re-run is still a bug in the test or the app: find the race (CLAUDE.md § Fix bugs at the source). What's never allowed: a bigger timeout, a `waitForTimeout`, a retry, `test.skip`/`fixme`, a loosened assertion, `networkidle`.

A re-run is fine once, and only to confirm a failure that isn't this PR's: the job died before any test ran (checkout, install, runner loss), or the same check is red on `main` too.

## A branch that fell behind

Merge `origin/main` into the PR branch, never rebase a branch someone else may have checked out, never force-push:

```
git fetch origin
git merge origin/main
```

A conflict in `pnpm-lock.yaml`: take `main`'s, then `pnpm install` to regenerate. A conflict in `e2e/fixtures/sample-data`: rerun `node e2e/fixtures/make-sample-data.mjs`, never merge it by hand.

## Reviews

- A small, local ask (a rename, a nit, an added test): do it, push, reply in the thread naming the commit, resolve it.
- A larger or design-level ask: reply with a proposal and ask the operator before building it.
- Review agents (`code-reviewer`, `ewr-reviewer`, `ui-designer` review) can be run locally on the branch to pre-empt the same findings: `/check`.

## Ask the operator before

- Anything irreversible or outside the PR: a release, a change of repo settings, deleting a branch that isn't yours.
- Merging. Merging is the operator's call even when everything is green; when they ask, squash (`gh pr merge <n> --squash`). The branch is deleted on merge; remove its worktree and `git pull --ff-only` in the main checkout.
- Approving a deploy. A published `api@` or `pipeline@` release waits for the `production` environment's approval, which is the operator's alone; never publish one unasked.
- A fix that needs a hydrology decision the brief (`../ewr-compliance-private/docs/requirements.md`) leaves open.

## Done

A PR is done when `CI gate` is green on the current head, it merges cleanly (`CLEAN`, or `UNSTABLE` only for checks that aren't required), and no review thread is waiting on you. Then say so once, with the link, and stop; nothing else is yours until the base, CI or a review changes.
