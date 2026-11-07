---
description: Dependency audit — pnpm audit, the vendored SheetJS Dependabot can't see, Dependabot coverage, action pinning, Node versions
---

Sweep dependencies for known advisories and drift, and check that every dependency has something watching it.

## What this is

- **Three packages**, each with its own lockfile, pnpm 10: the app at `/`, the sign-in API in `server/` (with the private `auth-kit`, a git dependency pinned to a commit), and the DWS pipeline in `pipeline/`.
- **Vendored, so Dependabot can't see it**: SheetJS `xlsx` is `vendor/xlsx-0.20.3.tgz`, depended on as `file:vendor/xlsx-0.20.3.tgz`, so the lockfile records its integrity. It was downloaded once from `cdn.sheetjs.com`, which publishes no checksum; `tools/supply-chain.test.ts` pins its SHA-256 and fails on any lockfile resolution without an integrity hash (auth-kit, by commit, is the one allowed exception). OSV reads a `file:` version as none, so scanners built on it may report advisories the vendored version already fixes.
- **GitHub Actions**, SHA-pinned.
- **Python** in `tools/` has no requirements file; `README.md` § Rebuild the data lists what it needs, and it never ships.
- The scheduled `.github/workflows/audit.yml` runs `pnpm audit --prod` weekly in all three packages and files an issue; this command adds the checks it doesn't cover.

## What to check

1. **Advisories.** `pnpm audit --audit-level=moderate`. For each: package, version, advisory, fixed version, and whether it reaches the shipped app or only dev tooling.
2. **Open audit issue.** `gh issue list --label dependency-audit --state open`, if `gh` is available; compare with today's result.
3. **The vendored SheetJS.** Is there a newer release on `cdn.sheetjs.com`, and does it fix anything? To take one: download the tarball once, replace `vendor/`, update `package.json`, the SHA-256 in `tools/supply-chain.test.ts`, and `pnpm install`.
4. **Dependabot coverage** (`.github/dependabot.yml`): npm at `/`, `server/` and `pipeline/`, and github-actions. Flag any manifest with no entry, and an `ignore` entry whose reason no longer holds.
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
