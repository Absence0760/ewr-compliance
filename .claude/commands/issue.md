---
description: Work one GitHub issue end to end — read it, branch in a worktree, route the work to the right workflow and agents, gate it with /check, and open a PR that closes the issue. The default entry point for a session driven by an issue.
argument-hint: <issue number or URL>
---

Take issue `$ARGUMENTS` from "open" to "a PR that closes it, green and reviewed". One issue per session and one PR per issue, unless the issue itself splits into independent parts (then one PR per part, each naming the issue).

## 1. Read the issue

`gh issue view <n> --comments`. Take in the body, every comment, the labels, and any linked issues, PRs or docs. Then, in two or three lines, state the goal, what "done" looks like, and anything the issue leaves open. If a fork changes what gets built (two readings of the ask, a product decision), ask before building; if it's a detail, pick the reasonable default, say which, and carry on.

Check it isn't already done or in flight: `gh pr list --search "<n> in:body" --state all`.

## 2. Branch in a worktree

```
git fetch origin
git worktree add ../ewr-<n>-<slug> -b <type>/<n>-<slug> origin/main
```

`<type>` is `fix`, `feat`, `docs`, `chore` or `test`. If the session was given a branch name, use that instead. Work only in the worktree (CLAUDE.md § Working alongside other Claude sessions).

## 3. Route the work

Read `docs/architecture.md` and, for what the app must do, `../ewr-compliance-private/docs/requirements.md`. Then pick the workflow by what the issue touches; more than one can apply.

| The issue touches | Use |
|---|---|
| A bug | Reproduce it first (a failing test is best), fix the cause, keep the test (CLAUDE.md § Fix bugs at the source) |
| Parsers or arithmetic in `src/lib/ewr`, or which file a node uses | `/safe-edit`; `/check` runs the `ewr-reviewer` agent on it |
| `tools/` or the real data | change the build and rebuild into the private repo (`README.md` § Rebuild the data), never the output by hand; check `../ewr-compliance-private/docs/data-review.csv` |
| Loading a user's file, or anything that calls another origin | `/safe-edit` (CLAUDE.md rule 1) |
| A screen's layout or design | `/polish-ui <screen>` (the `ui-designer` agent) |
| A domain question (would a hydrologist, ecologist or regulator accept this?) | the matching `persona-*` agent, read-only |
| Anything else | build it directly |

Keep the diff to what the issue asks. A real problem you find on the way is either fixed here (small, same area) or opened as its own issue; never left as a passing remark (CLAUDE.md § Fix bugs at the source).

## 4. Test while you work

`pnpm test` and `pnpm check`, plus `pnpm test:e2e` for a screen you changed.

## 5. Gate

1. `pnpm check && pnpm test`, plus `pnpm test:e2e` when a screen changed.
2. `/check` on the diff. Apply the findings you agree with; for the ones you don't, say why in the PR description.
3. Docs and tests changed with the code, or the PR says why not.

## 6. Commit, push, PR

- Commit path-scoped, one logical unit per commit: `git commit -m "<type>(<area>): <what>" -- <paths>`. No `Co-Authored-By` or generated-by trailer.
- `git push -u origin <branch>`. Never push `main`.
- Open the PR with `.github/pull_request_template.md`. The title reads like the commit subject; the body's Summary ends with `Closes #<n>` (or `Part of #<n>` for one part of a split issue).
- Don't merge it; that's the operator's call.

## 7. Drive it to green

Follow the `steward` skill (`.claude/skills/steward/SKILL.md`). A failure is this PR's to root-cause unless it's red on `main` too; `/fix-ci` is the loop. Answer review comments with a fix or a reason. When it's green, say so once, with the link and anything the operator needs to decide.

## 8. Clean up

After the PR merges: `git worktree remove ../ewr-<n>-<slug>`, and in the main checkout `git pull --ff-only`.
