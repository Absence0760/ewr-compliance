---
description: Hunt for untested behaviour and invariants and backfill the right layer of tests — no bug required. The proactive, area-scoped counterpart to the diff-scoped test-gap-checker. Commits scoped; lands through a PR, never pushes `main`.
argument-hint: "[optional scope — a module, feature, or path, e.g. src/lib/ewr/resolve.ts, 'the flow import'; omit to pick an under-covered area]"
---

Find behaviour that *works but isn't tested* and lock it in with tests at the right layer. Unlike `/bug-hunt` (whose deliverable is a fix) and the diff-scoped `test-gap-checker` agent, `/coverage-hunt` proactively hardens an **area** of already-landed code. If you trip over a real bug while writing the tests, fix it, but the goal here is durable coverage.

`$ARGUMENTS` is an optional scope. If empty, pick an under-covered area (step 1).

## Operating rules (root `CLAUDE.md`)

- **Test real behaviour, not the implementation.** Assert the observable contract and the invariant a regression would break. A test that only restates the code teaches nothing.
- **It must be able to fail.** Sanity-check by reverting the behaviour briefly. If the test stays green, it isn't testing anything. Cover the edges (null, empty, zero, a blank month, February, a boundary), not just the happy path.
- **No masking, ever.** No sleeps, inflated timeouts, retries or loosened assertions. Wait on real signals. If a deterministic wait needs a new app affordance, add it as a real readiness signal.
- **Match the layer.** Pure logic → a `*.test.ts` beside the module (vitest, no DOM, no network). User-visible behaviour → Playwright in `e2e/`. Numbers pin by hand arithmetic on the synthetic sample, never on real values, which belong in the private repo's tests, the way `src/lib/ewr/parsers.test.ts` does.
- **Commit scoped; PRs only, never push `main`.** `test(...)` commits, path-scoped. No `Co-Authored-By` or AI-attribution trailer.

## Procedure

### 1. Find the gap

- **If `$ARGUMENTS` is given:** that's the area.
- **If empty:** match source modules against their test files and rank by logic density × thin or no coverage × how directly it feeds the graphic. Skip generated data and types. State your pick and why in one line.
- For the chosen area, **enumerate the untested behaviours**: each branch, each error path, each domain rule in `CLAUDE.md`, each statement in `../ewr-compliance-private/docs/requirements.md` that it implements. List them before writing; that list is the work.

### 2. Confirm current behaviour

Read the contract and run the code, so the test encodes what the app actually does today. If today's behaviour looks wrong, that's a `/bug-hunt` finding: fix it and test the corrected behaviour.

### 3. Write tests that lock the contract

One assertion cluster per behaviour from the step-1 list. Name tests so a failure reads as a sentence about what broke. Include the failure paths.

### 4. Verify

- Run the new tests **and** prove they can fail.
- Run the nearby existing suite; report counts faithfully.
- Run `pnpm check` if you touched any non-test code.

### 5. Commit (scoped) on a PR branch

`test(<area>): …` commits, path-scoped. A real app affordance added for determinism is a separate non-test commit with its doc update. **Never push `main`**.

## Report

```
## /coverage-hunt — <area>

**Picked:** <area> — <one-line why it was under-covered> (omit if named)

**Behaviours now covered:** <bulleted list, each with its layer (unit/e2e)>

**Tests added:** <files + count>

**Bug found while testing:** <if any: what + fix — else "none; behaviour matched the contract">

**Verification:** <new tests N/N; can-fail check done; nearby suites N/N; pnpm check if touched>

**Commits:** <hash + subject>

**Still uncovered (recommended next):** <behaviours intentionally left — or "area is now well-covered">
```

## Tone

The deliverable is honest coverage, not a vanity green. Name what's now locked in and what you deliberately left. If you couldn't make a test able to fail, say why and don't ship it.
