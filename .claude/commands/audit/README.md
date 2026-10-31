# Audit commands

Read-only sweeps, invoked as `/audit/<name>`. Each reports findings (Critical / High / Medium / Low, then Clean) and applies nothing without confirmation. The knowledge of the app lives in the agent each one delegates to; the command says which area to sweep and what to look at first.

## Index

### Security (`repo-security-auditor`)

| Command | What it checks |
|---|---|
| [/audit/secrets](secrets.md) | Secrets in tracked files or history, committed env files, workflow secrets, the bundle |
| [/audit/xss](xss.md) | `{@html}`, map popups, dynamic `href`/`src`, text from a loaded file reaching the DOM |

The agent's other areas (`uploads`, `ci`, `public-repo`) have no command of their own: spawn it with `Audit area: <area>.`

### Data flows and accessibility (`compliance-auditor`)

| Command | What it checks |
|---|---|
| [/audit/third-party-data-flows](third-party-data-flows.md) | Every outbound request, and that a loaded file stays in the browser |
| [/audit/cookie-consent](cookie-consent.md) | No cookies, no third-party origins, only the app's own `localStorage` |
| [/audit/accessibility](accessibility.md) | WCAG 2.2 AA, the map and charts first |

### Dependencies (`general-purpose`)

| Command | What it checks |
|---|---|
| [/audit/deps](deps.md) | `pnpm audit`, the hand pin Dependabot can't see, Dependabot coverage, action pinning, Node versions |

### Dispatcher

| Command | What it does |
|---|---|
| [/audit/all](all.md) | The core sweep in parallel (security, deps, data flows) with one consolidated report |

## When to run

- **Before a release**: `/audit/all`, fix Critical and High, then `/release-readiness`.
- **Before making the repo public**: spawn `repo-security-auditor` with `Audit area: public-repo.`
- **After adding an outbound call or a stored key**: `/audit/third-party-data-flows`, `/audit/cookie-consent`.
- **After a screen redesign**: `/audit/accessibility`.
- **After a dependency major**: `/audit/deps`.
- **Monthly**: `/audit/all`; `audit.yml` already runs `pnpm audit` weekly.

For per-change checks use `/check` and `/safe-edit` instead.
