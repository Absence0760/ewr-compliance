---
description: Audit every place text from a loaded file or from static/data reaches the DOM as HTML — {@html}, map popups, dynamic href/src — via repo-security-auditor
---

Find every path where text the app doesn't control (a loaded file's name, header, title or cell, or a string in `static/data`) is rendered as HTML rather than text.

## Procedure

1. Spawn one **`repo-security-auditor`** agent with the prompt `Audit area: xss.` It checks, with `file:line` evidence:
   - `{@html}` and `innerHTML` in `src/`;
   - MapLibre popups built from strings (`setHTML`) in `src/lib/components/map/`;
   - dynamic `href` / `src` from data (`javascript:`, `data:`);
   - SVG or chart labels built from file text;
   - the file viewer (`src/lib/components/viewer/FileViewer.svelte`).
2. Relay its report as is: findings most severe first, then Clean.

For each finding, give a payload that proves it and the place the escaping belongs.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After adding anything that renders file text, and before a release.
