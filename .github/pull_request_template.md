## Summary

<!-- 1–3 sentences on what this PR does and why. End with "Closes #<n>" when it finishes an issue. -->

## Changes

<!-- Bulleted list of the user-visible or developer-visible changes. -->

-
-

## Surface touched

- [ ] Parsers and arithmetic (`src/lib/ewr`)
- [ ] App state (`src/lib/state`)
- [ ] Screens and components (`src/routes`, `src/lib/components`)
- [ ] Data build or sample data (`tools/`, `e2e/fixtures/sample-data`)
- [ ] E2E tests (`e2e/`)
- [ ] CI / GitHub Actions (`.github/`)
- [ ] Claude tooling (`.claude/`, `CLAUDE.md`)
- [ ] Docs only

## Data safety checklist

<!-- Tick what applies. Leave a row unticked if it genuinely doesn't apply,
     but don't delete it, so the next reviewer can see you considered it. -->

- [ ] A flow file a user loads stays in the browser: nothing new sends it anywhere
- [ ] Numbers on screen still come from `src/lib/ewr`, not from a component
- [ ] Chart line names are unchanged, or the brief in `../ewr-compliance-private/docs/requirements.md` changed
- [ ] Nothing real in this change: no client values, node codes or file names, and `static/data` stays out of git
- [ ] No secret, personal data or new third-party origin in any file

## Test plan

- [ ] `pnpm check && pnpm test`
- [ ] e2e for the screens changed: `pnpm test:e2e`
