# Contributing

How a change reaches `main`, and how `main` reaches production. The rules for Claude sessions are in `CLAUDE.md`; this is the same process for a person.

## Everything lands through a pull request

`main` is protected on GitHub. Nobody pushes to it, admins included:

- Every change is a pull request from a branch.
- **`CI gate` must be green.** It is the one required check: the `ci-gate` job in `.github/workflows/ci.yml`, which passes only when every job before it did. CodeQL, Scorecard and the labeler report on the PR but don't block it.
- No approval is required: this is a one-person repo, and nobody can approve their own PR. `CI gate` is the gate.
- Every review conversation has to be resolved before the PR can merge.
- History stays linear: **squash or rebase**, never a merge commit. The branch is deleted when the PR merges.

A PR that touches only `docs/`, `.claude/` or Markdown files skips the build, unit, e2e, server, pipeline and Terraform jobs, as does a draft; `CI gate` still has to pass.

### Making a change

```
git fetch origin
git worktree add ../ewr-<slug> -b <type>/<slug> origin/main
```

`<type>` is a conventional-commit type: feat, fix, chore, docs, refactor, test, perf, ci, build or revert. Then, in the worktree:

1. Change the code, with its tests and docs in the same change (`CLAUDE.md` § Every code change updates tests + docs).
2. Run `pnpm check`, `pnpm test` and `pnpm test:e2e` (after `pnpm data:sample`).
3. Commit path-scoped: `git commit -m "<type>(<scope>): <subject>" -- <paths>`. Every commit is checked for client terms (`SECURITY.md` § Public repo hygiene).
4. `git push -u origin <branch>`, then `gh pr create`. The title is a conventional commit too, `<type>(<scope>): <lowercase subject>` with no full stop, or `pr-title-lint` fails it. Fill in `.github/pull_request_template.md`.
5. When `CI gate` is green and no conversation is open, squash-merge: `gh pr merge <n> --squash`.
6. Clean up: `git worktree remove ../ewr-<slug>`, then `git pull --ff-only` in the main checkout.

A branch that falls behind takes `origin/main` by a merge (`git merge origin/main`), never a rebase or a force-push; the squash at the end keeps `main` linear either way.

## Releases and deploys

There are three things to ship, and each takes a deliberate step from `main`. None ships on a merge.

| What | How | Gate |
|---|---|---|
| The site (the static build and its data) | `tools/deploy.sh sample` or `tools/deploy.sh real`, from the operator's workstation with the `ewr-compliance` AWS profile. It builds a clean copy of `origin/main` | It refuses unless `CI gate` passed on `origin/main` and, for `real`, the private repo is exactly its upstream (`docs/hosting.md` § Build) |
| The sign-in API (`server/`) | Publish a release tagged `api@X.Y.Z`: `gh release create api@X.Y.Z --target main --generate-notes` | `deploy-lambdas.yml` checks the tag's commit is on `main` with a green `CI gate`, then waits for the **`production` environment's approval** |
| The DWS pipeline (`pipeline/`) | A release tagged `pipeline@X.Y.Z`, the same way | The same |

**The `production` environment** holds the only route to the AWS deploy role (`infra/oidc.tf` trusts `environment:production` and nothing else). It requires the owner's approval for every deploy, and deploys only from `main` or a tag matching `api@*` or `pipeline@*`. When a release starts a deploy, GitHub shows **Review deployments** on the run: approve it there. A rollback is the same workflow, run by hand with an older published tag: `gh workflow run deploy-lambdas.yml -f tag=api@0.1.0`.

A tag `vX.Y.Z` on `main`, matching `version` in `package.json`, marks a release of the app; `/release-readiness` is the go/no-go before one.

## Where the rest is

- `CLAUDE.md`: the rules, the commands, and the hydrology that must not drift.
- `docs/architecture.md`: the layout and conventions.
- `docs/hosting.md` and `infra/README.md`: the AWS hosting, and the operator's steps to go live.
- `SECURITY.md`: reporting a vulnerability, and keeping client material out of this public repo.
