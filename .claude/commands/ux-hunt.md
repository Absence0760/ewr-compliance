---
description: Hunt for interaction/UX defects in the app — dead-ends, broken back/forward and URL state, missing empty/loading/error states, stale selection, filter/sort inconsistency, keyboard traps. Fixes the objective bugs (with an e2e test), reports the judgment calls. Commits scoped; lands through a PR, never pushes `main`.
argument-hint: "[optional scope — a route or feature, e.g. the nodes table, the flow import, the map search; omit to sweep the main routes]"
---

Drive the app like a real user and hunt for **interaction defects**: flows that technically render but dead-end, lie, lose state, or strand the user. This is the behaviour-correctness cousin of `/polish-ui` (which redesigns layout) and `/persona` (which audits read-only from a role's point of view). `/ux-hunt` **lands fixes** for the objective defects and writes up the subjective calls.

`$ARGUMENTS` is an optional scope. If empty, sweep the routes: the map and panel (`src/routes/+page.svelte`), Nodes (`src/routes/nodes/`) and Notes (`src/routes/notes/`).

## What counts as a UX *bug* (objective — fix these)

- **Dead-ends.** A control leaves the user somewhere with no way forward: a percentile control with nothing to apply to, a dialog with no working close.
- **Broken navigation state.** Back, forward, reload and new-tab preserve the view. Anything written to the URL or `localStorage` is restored on load, and the visible state and the stored state agree.
- **State-coercion no-ops.** A reset that a downstream handler silently coerces back to a default, so the control appears to do nothing.
- **Missing or wrong empty, loading or error states.** A failed fetch of `static/data` shows a stuck "Loading…"; a filtered-to-zero table shows a blank pane; a selected node filtered out leaves a stale panel.
- **Stale selection.** A chart, notice or period from the previous node after switching, or an EC or percentile that no longer applies after a method switch.
- **Filter, sort and count inconsistency.** A summary count that disagrees with the rendered rows; the map and the Nodes table disagreeing about one node.
- **Keyboard and focus traps.** A dialog that doesn't trap focus or close on Escape; focus lost after an action.
- **Surprises when replacing data.** A second load silently merged with the first, or a loaded file lost with no warning.

## What is NOT in scope (hand off, don't fix here)

- Pure visual layout or redesign → `/polish-ui`.
- Subjective wording, or "should this flow exist" → write it up; don't unilaterally redesign.
- Accessibility depth (contrast ratios, ARIA, target sizes) → `/a11y-hunt`, `/audit/accessibility`.

## Operating rules (root `CLAUDE.md`)

- **Reproduce in the running app first.** A UX bug you can't demonstrate is a hypothesis. The fix is proven by an **e2e test that fails on the old behaviour**.
- **Fix the root cause, never mask.** No arbitrary waits or retries; fix the readiness signal.
- **Reuse components.** Build from what's in `src/lib/components` and `src/app.css`; don't copy-paste markup.
- **Be honest about non-findings.** A sound flow and a new e2e test that locks the good behaviour is a success.
- **Docs-as-code; commit scoped; PRs only, never push `main`.** Fix and test are separate path-scoped commits.

## Procedure

1. **Resolve scope** to concrete routes and components.
2. **Walk the flows like a user.** For each route: first load (empty and populated), every filter, sort and search (including filtered-to-zero), selection, back/forward/reload/new-tab, every button, and the keyboard path. Read the source to confirm the mechanism behind anything that smells wrong.
3. **Probe each candidate** with a Playwright snippet that asserts the broken behaviour; that's your repro and your soon-to-be regression test.
4. **Fix the objective defects** at the root.
5. **Lock with e2e** in `e2e/`. Wait on real signals, never sleeps. The test must fail on the old behaviour.
6. **Verify:** `pnpm check`, `pnpm test` and `pnpm test:e2e` (report counts).
7. **Commit** fix and tests scoped; push the branch and open a PR, **never push `main`**. Write up the subjective findings for the operator.

## Report

```
## /ux-hunt — <scope>

**Flows walked:** <routes/features exercised>

**Defects fixed:**
- <route> — <what stranded/confused the user> → <fix> | repro+test: <spec (e2e)>
- … (or "none objective; behaviour was sound")

**Reported (judgment calls / out of scope):** <subjective findings + where they belong — or "none">

**Verification:** <pnpm check; specs N/N>

**Commits:** <hash + subject>
```

## Tone

Lead with what was broken for the user and how it's fixed. Don't redesign on a whim: fix the defects, route the opinions to the operator.
