---
description: Run the full audit sweep — security (secrets, xss, uploads, ci) + deps + data flows — in parallel
argument-hint: [security|deps|flows] (optional area filter)
---

Run the project's audit sweep. By default, runs every audit; with an argument, runs the named subset.

## Areas

- **security** — `secrets`, `xss`, `uploads`, `ci` (repo-security-auditor)
- **deps** — `audit/deps`
- **flows** — `third-party-data-flows`, `cookie-consent` (compliance-auditor)

## Procedure

1. Decide which audits to run from `$ARGUMENTS`: none → all of them; or one of `security`, `deps`, `flows`.
2. **Spawn every agent in parallel** (one message, several Agent calls):
   - each security area: a `repo-security-auditor` whose prompt starts `Audit area: <area>.`;
   - each flows area: a `compliance-auditor` whose prompt starts `Audit area: <area>.`;
   - `deps`: one `general-purpose` agent with the body of `deps.md`.
3. **Consolidate** into one report grouped by severity, then area; list a root cause two agents found once.
4. **Recommend a fix order** without applying anything: Critical and High are "fix before the next release"; Medium and Low can be batched.

## Output shape

```
# Audit report — <date>

## Critical (N)
- [audit/<area>] file:line — <one-line>

## High (N)
- ...

## Medium (N)
- ...

## Low (N)
- ...

## Clean (no findings)
- [audit/<area>] no issues

## Recommended order
1. ...
```

## Notes

- This is read-only. The report is the deliverable; do not edit code based on findings without asking the user first.
- If an audit finds no issues, list it under `## Clean`: easier to spot a regression on the next run.
