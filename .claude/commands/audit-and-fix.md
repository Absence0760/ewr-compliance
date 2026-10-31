---
description: Pick one app area (random if none given), audit it for real bugs, fix at the root, and back the fix with as much unit/e2e coverage as the change warrants. Commits scoped; lands through a PR, never pushes `main`.
argument-hint: "[optional area — a path, module, or feature, e.g. src/lib/ewr/resolve.ts or 'the real time comparison']"
---

Deep-audit a single area of the project, fix the real issues you find, and ship tests with the fix. Unlike `/audit/*` (read-only sweeps) and `/check` (advisory pre-commit gate), this command **lands changes**: fix, tests and scoped commits.

`$ARGUMENTS` is the area to audit. If empty, you pick one (see step 1).

**When to use this vs the siblings:** `/audit-and-fix` = deep-audit ONE named area, fix it, ship tests. `/bug-hunt` = go wide across many targets. `/coverage-hunt` = harden behaviour that already works but isn't tested. `/perf-hunt`, `/ux-hunt`, `/a11y-hunt` = the same shape aimed at performance, UX and accessibility.

## Operating rules (root `CLAUDE.md`)

- **Fix the root cause, never mask.** No inflated timeouts, sleeps, retries, loosened assertions, skips or swallowed errors. If you can't fix it now, surface it explicitly and raise a tracked follow-up.
- **Be honest when there's no bug.** If the area is sound, say so plainly and make the deliverable the test coverage gap you closed. Do **not** invent a "fix".
- **Respect the rules.** Hard rules 1–5 and the domain rules stand. `src/lib/ewr` and anything handling a user's file are **load-bearing** (mandatory review in step 5).
- **Docs-as-code.** If you change a behaviour, command or convention, update its docs in the same commit.
- **Commit each logical unit, path-scoped; PRs only, never push `main`.** Fix and tests are separate commits (`git commit -m "…" -- <paths>`). No `Co-Authored-By` or AI-attribution trailer.

## Procedure

### 1. Resolve the area

- **If `$ARGUMENTS` is given:** that's the scope. Resolve it to concrete files.
- **If `$ARGUMENTS` is empty:** pick one yourself. Favour self-contained, testable, bug-prone, under-covered code. Rank candidates by few or no dedicated tests × how directly it feeds the graphic × logic density. Skip generated data, types and config. State your pick and *why* in one line.

### 2. Audit for real issues

- **Map the area before judging it**: call sites, the requirement in `../ewr-compliance-private/docs/requirements.md`, the invariants it must hold. For anything non-trivial, spawn an `Explore` agent, or `repo-security-auditor` or `ewr-reviewer` for a strict written review.
- Hunt for **correctness** bugs first (wrong numbers, broken rules, stale state, inconsistent logic across paths, edge cases), then security, then robustness. Stylistic nits are out of scope unless they hide a bug.
- For each candidate finding, **confirm it's real** by tracing the code across files. Discard plausible-but-wrong findings.

### 3. Fix the real issues at the root

Apply the durable fix. Match surrounding style. If a quick patch and the durable fix diverge, name the durable fix even if you ship the patch. Keep the fix tightly scoped.

### 4. Add as much coverage as the change warrants

- **Pure logic** → a `*.test.ts` beside the module.
- **User-visible behaviour** → Playwright in `e2e/`.
- Write tests that **lock in the fixed behaviour and the invariant it restores**, plus the obvious edge cases. If the area was sound, still backfill the missing coverage. If something is genuinely untestable, say why.

### 5. Verify and review

- Run `pnpm check` and the **new** tests, then the nearby existing tests. Report counts faithfully.
- If the change is load-bearing, run the `code-reviewer` agent on the diff, and `ewr-reviewer` for `src/lib/ewr` or `repo-security-auditor` for a user's file, and apply or push back before committing.

### 6. Commit (scoped) on a PR branch

Commit the **fix** and the **tests** as separate path-scoped commits (conventional-commit style). If you only added tests, one `test(...)` commit is fine. Do **not** `git push` unless asked.

## Report

```
## /audit-and-fix — <area>

**Picked:** <area> — <one-line why> (omit the "why" if the user named it)

**Issue(s) found:** <each real bug: what was wrong + the root-cause fix> — or "none; area is sound"

**Tests added:** <files + what they lock in (layer, count)>

**Verification:** <pnpm check; new tests N/N; nearby suites N/N; review verdict if run>

**Commits:** <hash + subject, one per line>

**Deferred / recommended:** <anything you intentionally didn't do, with the long-term fix named — or "nothing outstanding">
```

## Tone

Don't narrate the agent fan-out. Lead with the pick and the verdict. If you found and fixed a real bug, state it plainly; if you didn't, say the area was sound and the coverage was the gap.
