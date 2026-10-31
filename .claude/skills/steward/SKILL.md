---
name: steward
description: How to drive a pull request in this repo to green and mergeable — reading CI, reproducing each job locally, what counts as a flake, updating a branch that fell behind, answering reviews, and when to ask the operator. Use when watching, fixing or babysitting a PR here.
---

# Steward: driving a PR to green

Repo-specific conventions for a session that owns or watches a PR. The root `CLAUDE.md` rules still apply; this adds how CI here behaves and what to do about it.

## Read the PR first

On every wake, look at the whole PR on its current head: merge state, the `CI gate` check, every open review thread. `CI gate` (the `ci-gate` job in `.github/workflows/ci.yml`) is the one required check: it fans in on every job and is green only when none failed. A red `CI gate` names the upstream job that failed; that job is the thing to fix.

`pr-mergeable` failing means GitHub couldn't build a merge ref (a conflict), so **ci.yml didn't run at all**: green-looking PR checks from the other workflows prove nothing. Resolve the conflict first.

## Docs-only and draft PRs

The `changes` job decides whether anything besides `docs/`, `.claude/` and `*.md` changed, and a draft counts as no. If not, the `test` and `e2e` jobs are skipped (skipped counts as passing). Jobs that still run: `claude-tooling`, `gitleaks`, and the `pull_request_target` workflows (`pr-title-lint`, `labeler`, `pr-mergeable`).

## Reproduce a failed job locally

Run the same command the job runs.

| Job | Locally |
|---|---|
| Typecheck, unit tests and build (`test`) | `pnpm check`, `pnpm test`, `pnpm build` |
| E2E tests (`e2e`) | `pnpm test:e2e > e2e.log 2>&1` (never piped into `grep` or `head`: it can hang) |
| Claude tooling (`claude-tooling`) | `python3 .claude/hooks/git-scope-guard.test.py` |
| gitleaks | the finding names the file and rule; remove the secret and treat it as leaked (rotate), never allowlist a real one |
| `pr-title-lint` | the title is `type(scope): lowercase subject` with no trailing period |

Read the failure first: `gh run view <run> --log-failed`. An e2e failure uploads `playwright-results` as an artifact.

## Flakes

"Flake" is not a root cause. A test that fails once and passes on a re-run is still a bug in the test or the app: find the race (CLAUDE.md § Fix bugs at the source). What's never allowed: a bigger timeout, a `waitForTimeout`, a retry, `test.skip`/`fixme`, a loosened assertion, `networkidle`.

A re-run is fine once, and only to confirm a failure that isn't this PR's: the job died before any test ran (checkout, install, runner loss), or the same check is red on `main` too. `pnpm install` fetches SheetJS from its CDN, so an install that fails on that URL is one of these.

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
- Merging. Merging is the operator's call even when everything is green.
- A fix that needs a hydrology decision the brief (`../ewr-compliance-private/docs/requirements.md`) leaves open.

## Done

A PR is done when `CI gate` is green on the current head, it merges cleanly, and no review thread is waiting on you. Then say so once, with the link, and stop; nothing else is yours until the base, CI or a review changes.
