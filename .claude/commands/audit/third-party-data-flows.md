---
description: Map every outbound request and check that a loaded flow file stays in the browser — via compliance-auditor
---

The recorded position: a flow file stays in the browser, and everything the app needs comes from its own origin, with one exception the operator sets, the real-time source (`CLAUDE.md` rule 1, `docs/architecture.md`). Check the code still agrees.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: third-party-data-flows.` It checks, with `file:line` evidence:
   - every `fetch(`, and any `XMLHttpRequest`, `sendBeacon` or `WebSocket`, in `src/`;
   - map styles, tiles, glyphs and sprites in `src/lib/components/map/`: any origin but the app's own;
   - scripts, fonts and images in `src/app.html` and the build output;
   - what each request carries, and why.
2. Relay its report as is: findings most severe first, then Clean.

Output a table (origin, what it carries, when, why) and the findings where code and position disagree.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After adding an outbound integration, and before a release.
