---
description: Design, build or review one screen. Delegates to the `ui-designer` agent. `/polish-ui <target>` builds; `/polish-ui review <target>` reports only.
argument-hint: [review] <route, component or panel>, or "review diff"
---

Run the `ui-designer` agent on `$ARGUMENTS`.

## When to use it

**Right fit:**

- A screen that wastes the first viewport, crowds out its result as data grows, or doesn't stack on a phone.
- Before landing any UI change: `/polish-ui review diff`.

**Wrong fit (say so and stop):**

- A one-line CSS tweak: just edit it.
- A new feature with no agreed content: plan that first, from `../ewr-compliance-private/docs/requirements.md`.
- "Polish everything": pick one target; run the command again for the next.

## Resolving the target

- A **route** (`/`, `/nodes`, `/notes`) → `src/routes/<route>/+page.svelte`.
- A **panel or component** (the compliance panel, the map, the file viewer) → its folder under `src/lib/components/`.
- A **file path** → used as-is.
- `review diff` (or `review` with no target) → the working diff; `review <branch>` → that branch against `main`.
- Empty → list the routes with one line each on why each matters, and ask which.

## The flow

1. **Pre-flight:** the target exists; `pnpm check` passes on the tree (if it already fails, fix that first).
2. **Spawn `ui-designer`** with the mode and target on the first line:
   - build: `build: <target>. The operator's intent: <original argument>.` Pass `isolation: "worktree"` when other sessions or agents are working in this checkout.
   - review: `review: <target>.` (read-only; no worktree needed.)
3. **Relay the report:** files changed, screenshot paths, the "nothing lost" inventory check, the tests that ran, and anything deferred. For a review, the findings ranked by impact.
4. **Land it** through a PR; a review's findings are fixed in a build run or by hand.

## Not a replacement for

- `/check` (code review, test gaps, doc hygiene on a diff).
- `/a11y-hunt` and `/ux-hunt` (defects found by driving the app); `/persona` (domain users' point of view).
