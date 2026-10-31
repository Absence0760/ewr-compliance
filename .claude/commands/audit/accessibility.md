---
description: WCAG 2.2 AA sweep of the app, the map and charts first — via compliance-auditor
---

Find where the app misses WCAG 2.2 AA. The map and the charts are canvases, so a result that exists only there comes first.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: accessibility.` It checks, with `file:line` evidence:
   - semantic structure, names on icon buttons and inputs, table headers, focus order and visibility, keyboard reach, `prefers-reduced-motion`;
   - contrast, computed from the tokens in `src/app.css`, not guessed;
   - 390 px layouts and zoom to 200 %;
   - the map and charts: a text alternative for each (MapLibre and uPlot canvases carry none by default);
   - what the specs in `e2e/` cover and what they don't.
2. Relay its report as is: findings most severe first, then Clean.

Compute every contrast or size claim. For fixing what this finds, `/a11y-hunt` is the loop; the `persona-accessibility-user` agent gives the human view.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After a screen redesign, and before a release.
