---
description: Check that the app still sets no cookies and loads no third-party script, font or tracker, so no consent banner is needed — via compliance-auditor
---

The recorded position is no cookies, no analytics and no third-party origins, with the app's own preferences in `localStorage` (`src/lib/state/app.svelte.ts`), so no banner. The host's access gateway sets a strictly necessary sign-in cookie (`docs/hosting.md` § Access control); that is expected and not a finding. A finding is anything the app itself adds.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: cookie-consent.` It checks, with `file:line` evidence:
   - any `document.cookie`, and every `localStorage` / `sessionStorage` key, and whether it could identify a person;
   - any `<script>`, font, image or `fetch` to another origin.
2. Relay its report as is: findings most severe first, then Clean.

List each stored key with its purpose and whether it is strictly necessary.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After adding a stored key or an external asset, and before a release.
