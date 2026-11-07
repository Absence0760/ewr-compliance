---
description: Pre-release go/no-go. Checks main, CI, what would ship since the last tag, the generated data, the brief, and open security signals. Reports a green/red checklist. Read-only; never tags or publishes.
argument-hint: "[version, e.g. 0.2.0] (optional)"
---

Run the go/no-go checklist before a release. Report it; never tag, push or publish. The operator runs `gh release create` after reading it.

## How releases work here

A release is a tag `vX.Y.Z` on `main`, matching `version` in `package.json`. The deploy target is the AWS site in af-south-1 (`docs/hosting.md`): the operator deploys the static build from the workstation with `tools/deploy.sh real`, and CI deploys the API and the pipeline on `api@X.Y.Z` and `pipeline@X.Y.Z` releases, each waiting for the `production` environment's approval (`CONTRIBUTING.md` § Releases and deploys). This command never deploys; before a first deploy, also walk `docs/hosting.md` § Deploy readiness and report which of its checks are not yet done.

## Procedure

Mark each gate green, amber or red with a one-line reason.

### 1. main and CI

```
git fetch origin main
git log -1 --format='%h %s' origin/main
gh run list --branch main --workflow ci.yml --limit 1 --json status,conclusion,headSha
```

Red if `CI gate` on `origin/main`'s head isn't `completed/success`. `server/` and `pipeline/` ship separately: if either changed since its last `api@`/`pipeline@` release, say so (amber).

### 2. What would ship

```
git tag --list 'v*' --sort=-v:refname | head -1
```

With no earlier release, compare against the first commit and say so. Then `git log --oneline <last>..origin/main`. Red if nothing would ship. Red if `version` in `package.json` doesn't match the version being released.

### 3. The data

- `git log --oneline <last>..origin/main -- tools/`, and the same in the private repo over `static/data`: is every data change paired with its build change?
- Every `kind` in `../ewr-compliance-private/docs/data-review.csv` that a person should check: has someone looked since the last release?
- Amber if `tools/` changed and the private repo's `static/data` did not, or the reverse.

### 4. The brief

Walk `../ewr-compliance-private/docs/requirements.md` against the app. Anything it asks for that isn't built is amber, named. A wrong line name or default is red. The DWS store holds daily flow only until the plan's Q1 is answered: monthly volumes and 12-minute readings from DWS are expected to be missing, so say so.

### 5. Open signals (amber, never blocking)

```
gh issue list --label dependency-audit --state open
gh issue list --label secret-scan --state open
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[]|select(.state=="open")]|length'
```

Once the repo is public, also `gh api repos/{owner}/{repo}/code-scanning/alerts --jq '[.[]|select(.state=="open")]|length'`.

### 6. Report

```
# Release readiness — <date>

| Gate | Status | Detail |
|---|---|---|
| CI gate green on origin/main | green / red | ... |
| Commits since <tag> | n | ... |
| Version matches package.json | green / red | ... |
| Data and build agree | green / amber | ... |
| Brief covered | green / amber / red | ... |
| Open signals | amber | ... |

## Changelog draft
- <sha> <subject>

## Verdict
READY — gh release create vX.Y.Z --target main --title "X.Y.Z" --generate-notes
or NOT READY — <the red items>
```

If `gh` is missing or signed out, mark those gates skipped and say how to check by hand; don't fail the report.

Read-only: never tag, push, publish, or fix a red gate here.
