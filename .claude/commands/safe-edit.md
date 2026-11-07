---
description: Implement a non-trivial change with a code-reviewer agent loop — coder → review → fix → review → ready-to-commit. Costs ~2-3x a normal edit; use when the change warrants the extra rigor.
argument-hint: <task description>
---

Implement the task `$ARGUMENTS` with a project-specific code-reviewer agent in the loop.

## When to use this command

**Right fit:**
- Parsers and arithmetic in `src/lib/ewr/parsers.ts`: anything that changes a value on the compliance graphic (also run `ewr-reviewer`).
- Which EC, method or file a node uses (`src/lib/ewr/resolve.ts`), and the notices that explain it.
- Loading a user's file, and anything that reaches another origin (CLAUDE.md rule 1).
- Text from a loaded file reaching the DOM.
- `../ewr-compliance-private/tools/build_data.py` decisions about which file belongs to which node and EC.
- GitHub Actions permissions, or a `pull_request_target` workflow.
- Anything you want a second pair of eyes on before commit.

**Wrong fit — refuse and tell the user to edit directly:**
- Typos and one-line doc corrections.
- Comment edits.
- Single-property CSS or Svelte template changes.
- Dependency-version bumps that don't change source.
- Anything where the diff is going to be < ~10 lines and touches no project rule.

The cost of this loop is real (~2-3x tokens, one or two `code-reviewer` agent runs). **If the task is trivial, abort and tell the user to just edit it normally.**

## The loop

1. **Coder pass.** Implement the task as you normally would. Do NOT commit yet.

2. **Round 1 review.** Spawn the `code-reviewer` agent with the prompt:
   > "Review the working diff against this project's documented conventions. The task being implemented is: `$ARGUMENTS`. Output the strict format from your spec."

   The reviewer outputs:
   - `Status: CLEAN` → go to step 5.
   - `Status: NEEDS_CHANGES` with a numbered list of concrete file:line changes → go to step 3.

3. **Apply fixes.** For each Critical or Improvement item:
   - If the finding is correct, apply the suggested change.
   - If the finding is wrong, state explicitly *why* you're not applying it. Do NOT silently skip.
   - If the finding is borderline, apply it; the reviewer is configured to retract on the next round, so over-applying is safe.

4. **Round 2 review.** Spawn `code-reviewer` again with the same prompt. Three branches:
   - `Status: CLEAN` → go to step 5.
   - `Status: NEEDS_CHANGES` again → **stop the loop**. Surface the remaining findings to the user along with what you tried in Round 1. Do not auto-cycle to Round 3.
   - Reviewer retracts Round 1 findings → also `CLEAN`; go to step 5.

5. **Ready-to-commit handoff.** Tell the user what was changed, which review round produced the clean status, and any Notes or Out-of-scope observations. Ask whether to commit, unless the task already asked for a PR.

6. **On user "yes":** commit path-scoped on the PR branch's worktree (`git commit -m "…" -- <paths>`; CLAUDE.md § Working alongside other Claude sessions), in the style of the recent log, with no `Co-Authored-By` or generated-by trailer. Push the branch and open a PR; never push `main`.

## Loop-termination guarantees

- Hard cap: 2 review cycles. Round 3 is forbidden.
- The reviewer cannot trigger a re-cycle with abstract concerns alone: its spec requires concrete numbered file:line changes for `NEEDS_CHANGES`. If it tries to cycle on vague "consider X" findings, treat as `CLEAN` and surface the comments to the user.
- The reviewer's `Out-of-scope observations` are informational only and never trigger a cycle.
- If the coder disagrees with a Round 1 finding and doesn't apply it, quote the disagreement in the Round 2 prompt so the reviewer can re-evaluate.

## What this command does NOT replace

- `/check` is the lighter pre-commit gate: review, test gaps and doc hygiene, single pass, advisory.
- `pnpm check` and `pnpm test` still run when you'd normally run them.
- `/audit/*` is still the right tool for periodic broad sweeps. `/safe-edit` is per-change.

## Tone

Don't narrate the loop step by step. The user sees your normal coder updates, a short "Round 1 review found N findings: [list]; applied them" or "came back clean", and a short "ready to commit, want me to?" handoff, or, if the loop ends without consensus, a clear summary of what's still contested.
