---
description: Go wide hunting for real correctness bugs across the project — reproduce each with a probe, confirm it's real, fix at the root, lock it with a regression test, then sweep sibling paths. Multi-round; commits scoped; lands through a PR, never pushes `main`.
argument-hint: "[optional scope — a module, feature, or path, e.g. 'the flow import', src/lib/ewr/resolve.ts; omit to let it choose high-yield targets]"
---

Hunt for genuine correctness bugs and land the fixes. This is the **cross-cutting, multi-round** companion to `/audit-and-fix` (which deep-audits a single named area) and the read-only `/audit/*` sweeps: `/bug-hunt` ranks high-yield targets, finds bugs in each, **proves them with a runnable probe before believing them**, fixes the root cause, ships a regression test that would fail on the old code, and then sweeps the sibling paths that share the same pattern.

`$ARGUMENTS` is an optional scope. If empty, you pick targets (step 1).

**When to use this vs the siblings:** `/bug-hunt` = go wide, prove each bug with a probe, fix at root, sweep siblings. `/audit-and-fix` = deep-audit ONE named area. `/coverage-hunt` = harden behaviour that works but isn't tested. `/perf-hunt`, `/ux-hunt`, `/a11y-hunt` = the same hunt shape aimed at performance, UX and accessibility.

## Operating rules (root `CLAUDE.md`)

- **Prove it before you believe it.** A bug isn't real until you've reproduced it with a failing probe (a throwaway vitest case, a file from `static/data`, a browser snippet). A hypothesis you can't reproduce is not a finding. Delete throwaway probes before committing.
- **Fix the root cause, never mask.** No inflated timeouts, sleeps, retries, loosened assertions or swallowed errors. If you can't fix it now, surface it explicitly and raise a tracked follow-up.
- **Be honest when there's no bug.** If a target is sound, say so and make the deliverable the coverage gap you closed. Never invent a "fix".
- **Respect the rules.** A flow file stays in the browser, `static/data` isn't hand-edited, numbers come from `src/lib/ewr`, and the domain rules stand. `src/lib/ewr` is load-bearing (mandatory review, step 7).
- **Docs-as-code.** A behaviour, command or convention change updates its docs in the same commit.
- **Commit each logical unit, path-scoped; PRs only, never push `main`.** Fix and tests are separate commits (`git commit -m "…" -- <paths>`). No `Co-Authored-By` or AI-attribution trailer.

## Where bugs tend to live

- **Month and unit slips.** Oct-first arrays read as calendar months, `DAYS` used where real month lengths belong or the reverse, Mm3 shown as m3/s.
- **Inconsistent logic across paths that should agree.** The map popup, the panel and the Nodes table showing different ECs or statuses for one node; the matrix and series import paths treating a gap differently.
- **Parsers that handle the common case and silently drop the rest.** A short row, a blank month, a quality flag, a two-digit year, a different delimiter, a BOM, a date in another order. A dropped row still gives a plausible chart.
- **Missing treated as zero.** `null` reaching arithmetic; `||` where `??` is needed, so a real `0` is lost; a truthiness check on a value that can be 0.
- **Selection and state gaps.** A chart left over from the previous node, a stored choice applied to a node that no longer offers it, a percentile or EC that survives a method switch and no longer applies.
- **Fallbacks that lie.** Anything that feeds a compliance verdict must fail visibly: a fallback EC or file with no notice is the bug.
- **Edge cases:** an empty file, one month of data, a leap February, a period with no months, a node with no coordinates or no EC.

## Procedure

### 1. Pick targets

- **If `$ARGUMENTS` is given:** resolve it to concrete files and hunt within.
- **If empty:** rank candidates by logic density × thin coverage × recent activity (`git log --oneline -20 <file>`), skipping generated data and types. State each pick and why in one line. Prefer targets you haven't hit in a recent session.

### 2. Map before judging

Recon the target's contract first: call sites, the requirement in `../ewr-compliance-private/docs/requirements.md`, the invariants it must hold. For anything non-trivial spawn an `Explore` agent to map callers and siblings rather than guessing from one file.

### 3. Hunt and reproduce

For each candidate: trace the code to confirm the mechanism, then **write a probe that fails on the current code**. No probe, no finding. Name probes so they're easy to delete (e.g. `_probe.test.ts`).

### 4. Fix at the root

Apply the durable fix, matched to the surrounding style and tightly scoped to the issue. If a quick patch and the durable fix diverge, name the durable fix even if you ship the patch.

### 5. Lock it with a regression test

Promote the probe into a real test at the right layer: pure logic → a `*.test.ts` beside the module; user-visible → Playwright in `e2e/`. The test must **fail on the old code and pass on the fix**, and assert the invariant the bug violated. Wait on real signals, never sleeps.

### 6. Sweep the siblings

The bug you found is rarely unique. Grep for the same shape elsewhere and either fix and test those too, or state explicitly that they're already correct, with the one-line reason.

### 7. Verify and review

- Run `pnpm check` and `pnpm test`, plus `pnpm test:e2e` for a screen. Report counts faithfully.
- For a change to `src/lib/ewr`, run the `ewr-reviewer` agent and apply or push back before committing.

### 8. Commit (scoped) on a PR branch

Fix and tests as separate path-scoped commits, conventional-commit style. Docs ride with the commit that changed the behaviour. Then go back to step 3 for the next target until you've covered the scope. **Never push `main`**: push your branch and open a PR.

## Report

```
## /bug-hunt — <scope or "self-selected">

**Targets:** <each pick + one-line why>

**Bugs found & fixed:**
- <file:line> — <what was wrong> → <root-cause fix> | repro: <how> | test: <file (layer)>
- … (or "none — targets were sound; coverage backfilled where thin")

**Sibling sweep:** <same-shape paths checked — fixed too / confirmed correct + why>

**Verification:** <pnpm check; new tests N/N; nearby suites N/N; review verdict if run>

**Commits:** <hash + subject, one per line>

**Deferred / recommended:** <leads with the long-term fix named + tracked follow-up — or "nothing outstanding">
```

## Tone

Lead with the verdict, not the process. State a real bug plainly with its repro; if a target was sound, say so and point at the coverage you added.
