---
description: Find secrets that may have leaked into a tracked file, git history, the client bundle, a workflow or a log — via repo-security-auditor
---

Find any secret or credential in this repo. The app has no secrets of its own and nothing it could keep one in: everything in `src/` ships to every browser, and the repo may go public (CLAUDE.md rule 2).

## Procedure

1. Spawn one **`repo-security-auditor`** agent with the prompt `Audit area: secrets.` It checks, with `file:line` evidence:
   - secret-shaped literals in tracked files and in history (`git log -p -S`), any tracked `.env`;
   - an API key or token in `src/`, or `import.meta.env` / `process.env` reads;
   - workflow `env:` blocks with literals, secrets echoed in logs, and any secret other than `GITHUB_TOKEN`;
   - what gitleaks has reported (`gh issue list --label secret-scan`).
2. Relay its report as is: findings most severe first, then Clean.

Never paste a found value into the report: name the variable and where it is. A secret that ever reached git history needs rotating, whatever happened after.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding on a PR branch.

## When

After adding a workflow or an integration, before a release, and before making the repo public.
