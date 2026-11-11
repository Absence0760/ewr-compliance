# Security

To report a vulnerability, use GitHub's private vulnerability reporting on this repository, or contact the owner through their GitHub profile. Please don't open a public issue.

This is a static, client-side app behind a sign-in. The hosted site serves nothing, its data included, without CloudFront signed cookies, which only the sign-in API in `server/` issues, to people on the site's list after an emailed code. The list, the codes, the sessions and the audit log are one DynamoDB table; the sign-in logic is the private package `auth-kit`. `pipeline/` pulls DWS's published flow into the site's store. Flow files a user loads are read in their browser and are not uploaded, to `server/` or anywhere else. The site sets only strictly necessary cookies and has no analytics. What each part does and what personal data it holds: `docs/architecture.md` § Users and access, and `docs/hosting.md` § Personal data.

## Public repo hygiene

This repository is public. Client material (real flow or EWR values, node codes, sites, file names, the brief) stays in the private repo, `ewr-compliance-private`, and so does the list of terms that would identify it: `../ewr-compliance-private/client-terms.txt`, one term per line, `#` for comments. It is built from the real data by `../ewr-compliance-private/tools/build_client_terms.py`, rerun after any data rebuild; terms the data can't know are added by hand below its `# --- kept by hand ---` line. `EWR_PRIVATE_DIR` or `CLIENT_TERMS_FILE` point elsewhere.

`pnpm install` points git at `.githooks/` (`tools/git-hooks.mjs`), so every commit, in every checkout and worktree, is checked by `tools/check-client-terms.mjs`: the staged changes, their paths and the commit message. A hit blocks the commit. The guard names the file, the line and the term's number in the list, never the term, and stars any term out of a path it reports, since a log is as public as the repo. Without the list (a fresh clone, CI, a fork) it does nothing. `pnpm check:terms` checks every tracked file, and `node tools/check-client-terms.mjs --history` every ref's history. A hit in history needs a rewrite and a force push: ask the owner.

If the [pre-commit](https://pre-commit.com) framework is installed, the same hooks also run `.pre-commit-config.yaml`: gitleaks on the staged changes, and checks for merge-conflict markers, large files, YAML and JSON. CI runs gitleaks on every push either way.

## Supply-chain scanning

`.github/workflows/supply-chain-scan.yml` runs two scanners on every PR, every push to `main`, Mondays and by hand. Both are advisory: findings go to Security > Code scanning (tools `zizmor` and `osv-scanner`) and the job summary, and neither job fails on a finding or is part of `CI gate`.

- **zizmor** reads the workflows and `dependabot.yml` for template injection, broad permissions, dangerous triggers, persisted credentials, cache poisoning and unpinned or impostor actions. A finding with no fix is kept with an inline `# zizmor: ignore[<audit>]` and its reason beside it, never a config-wide ignore. Its online audits call only the GitHub API, with the run's token.
- **osv-scanner** checks the three lockfiles (the app, `server/`, `pipeline/`) against the OSV database, downloaded and matched offline, so no package list leaves the runner. An advisory with no actionable fix gets an ID-scoped, expiring `[[IgnoredVulns]]` entry with its reason in `osv-scanner.toml`. It does not see `infra/.terraform.lock.hcl` (Terraform providers), the private `auth-kit` itself (its own dependencies are in `server/pnpm-lock.yaml` and are scanned), or the system tools `tools/build_geo.py` calls. The vendored SheetJS is matched by name, so advisories its CDN version already fixes report and are ignored there with that reason.

`audit.yml` (weekly `pnpm audit`) and `/audit/deps` cover the same lockfiles from another database.
