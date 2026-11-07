---
description: Check that the site still sets only its strictly necessary sign-in cookies and loads no third-party script, font or tracker, so no consent banner is needed — via compliance-auditor
---

The recorded position is strictly necessary cookies only, no analytics and no third-party origin but the ArcGIS layers, with the app's own preferences in `localStorage` (`src/lib/state/storage.ts`), so no banner. The sign-in API (`server/`) sets the HttpOnly session cookie and the four CloudFront signed cookies that every file needs (`docs/hosting.md` § Access control); those are expected and not a finding, as long as their names, scope and lifetimes match the docs and the privacy notice. A finding is any other cookie, anything the app itself stores that identifies a person, or a tracker.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: cookie-consent.` It checks, with `file:line` evidence:
   - every `Set-Cookie` the API sends (`server/src/`), and any `document.cookie` in `src/` or `static/signin/`;
   - every `localStorage` / `sessionStorage` key, and whether it could identify a person;
   - any `<script>`, font, image or `fetch` to another origin.
2. Relay its report as is: findings most severe first, then Clean.

List each stored key with its purpose and whether it is strictly necessary.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After adding a stored key or an external asset, and before a release.
