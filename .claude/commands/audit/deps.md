---
description: Dependency audit — pnpm audit, the hand pin Dependabot can't see, Dependabot coverage, action pinning, Node versions
---

Sweep dependencies for known advisories and drift, and check that every dependency has something watching it.

## What this is

- **One package**: `package.json` and `pnpm-lock.yaml`, pnpm 10.
- **Hand pin Dependabot can't see**: SheetJS `xlsx`, a CDN tarball URL in `package.json`. OSV reads that URL as no version, so scanners built on it may report advisories the pinned version already fixes.
- **GitHub Actions**, SHA-pinned.
- **Python** in `tools/` has no requirements file; `README.md` § Rebuild the data lists what it needs, and it never ships.
- The scheduled `.github/workflows/audit.yml` runs `pnpm audit` weekly and files an issue; this command adds the checks it doesn't cover.

## What to check

1. **Advisories.** `pnpm audit --audit-level=moderate`. For each: package, version, advisory, fixed version, and whether it reaches the shipped app or only dev tooling.
2. **Open audit issue.** `gh issue list --label dependency-audit --state open`, if `gh` is available; compare with today's result.
3. **The hand pin.** Is there a newer SheetJS release on its CDN, and does it fix anything?
4. **Dependabot coverage** (`.github/dependabot.yml`): npm at `/` and github-actions. Flag any manifest with no entry, and an `ignore` entry whose reason no longer holds.
5. **Action pinning.** Every `uses:` in `.github/workflows/` is a full SHA with a version comment.
6. **Node.** `engines` (`>=24`), the `node-version` in the workflows, and `@types/node` agree.

## Report

- **Critical**: an exploitable advisory in code that ships.
- **High**: an advisory with a fix available; a manifest with nothing watching it.
- **Medium**: an overdue upgrade; a version mismatch between CI and `engines`.
- **Low**: grouping that could be tighter.

For each: package, version, advisory link, the file to change, the command.

## Delegate to

A `general-purpose` agent with this file as the prompt. Read-only: recommend upgrades, don't apply them (a major bump is its own PR).
