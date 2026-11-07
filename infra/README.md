# infra

Terraform for hosting EWR Compliance on AWS: the account skeleton (P1), the gated static site (P2), the sign-in (P3) and the DWS store (P4) of the private hosting plan. Built after `project-water-management`'s `infra/`.

Nothing here is applied by CI. The operator plans and applies from the workstation, with their own SSO profile. CI runs `bin/check-infra.sh` only: `terraform fmt`, `validate`, and the plan-only tests in `tests/` against mocked providers, with no credentials.

This repo is public. The account ID stays in `backend.config` (gitignored), and the values (domain, zone, alert mailbox, public keys) in `infra-secrets/ewr-compliance/prod.tfvars`. `terraform.tfvars.example` shows the shape with placeholders.

## Files

| File | What it makes |
|---|---|
| `main.tf` | Providers: `var.aws_region` (af-south-1) and a `us_east_1` alias for CloudFront's certificate, WAF and metrics, and for budgets. `default_tags` on both. The S3 backend, its bucket from `backend.config` |
| `variables.tf` | Every input. `aws_region` is refused unless it is af-south-1 or `data_outside_south_africa = true`. Feature flags (`site_enabled`, `auth_enabled`, `dws_enabled`, `dws_schedule_enabled`, `deploy_lambda_functions`, `cost_anomaly_threshold_usd`) are off by default |
| `oidc.tf` | Looks up the bootstrap's `ewr-compliance-deploy` role, refuses a trust wider than this repo's `production` environment, and attaches a policy only once there are Lambdas to update (the API once `auth_enabled`, the DWS pipeline once `dws_enabled`, each by itself), for their code only. The role never gets S3 or CloudFront: the site and data go up from the workstation only |
| `alarms.tf` | Alert topics in af-south-1 and us-east-1, mailing `budget_alert_email`; monthly and daily budgets; Cost Anomaly Detection (off until turned on); the CloudFront 5xx and request-flood alarms |
| `site.tf` | With `site_enabled`: the private bucket (versioned, old versions kept 30 days), OAC, the us-east-1 certificate validated in the delegated zone, the key group from `cloudfront_public_keys`, the empty signing-key secret, the distribution (PriceClass_All; default behaviour signed; `/signin/*` unsigned; `/api/*` to the API once `auth_enabled`; `/dws/*` to the DWS store, signed, once `dws_enabled`) and its DNS records |
| `edge_functions.tf` | The viewer-request function: unsigned or expired requests get a 302 to `/signin/` (or 401 JSON with `X-Requested-With`), folder paths get `index.html` |
| `security_headers.tf` | The response-headers policies: the site's headers (those the retired `static/_headers` file set) plus HSTS, and the API's |
| `waf.tf` | Per-IP rate limits, `/api/auth/*` and every path, and the blocked-requests alarm |
| `auth.tf` | With `auth_enabled` (P3): the user table (`auth-kit`'s single table: PITR, TTL on `ttl`, deletion protection), the API Lambda (stub code, which CI replaces) and its Function URL, its runtime secret (the code and session keys and the origin secret, `random_password`s written write-only), its role (`auth-kit`'s actions on the table, SES as `no-reply@` only, its two secrets, its log group), SES (configuration set, DKIM, MAIL FROM, DMARC), and the API-error, bounce, complaint and `auth.locked` alarms |
| `dws.tf` | With `dws_enabled` (P4): the DWS store's bucket (versioned, old versions kept 30 days; CloudFront may read `serve/dws/*` only), the pipeline Lambda (stub code, which CI replaces; no async retries; a DLQ), its role (its bucket prefixes, the lease key, the DWS API key secret, its log group, its metric namespace; no delete), the empty DWS API key secret, the daily EventBridge rule (DISABLED until `dws_schedule_enabled`), and the lag (with the schedule), stopped, failed and DLQ alarms |
| `dws_backfill.tf` | With `dws_enabled`: the Step Functions backfill over date windows (`tools/dws-backfill-plan.mjs`), one at a time with a pause, never retrying a refusal, and its failed-execution alarm |
| `outputs.tf` | `site_bucket` and `distribution_id`, which `tools/deploy.sh` reads; `users_table` and `auth_runtime_secret_arn`, which the operator tools read; `dws_bucket`, which `tools/dws-stations.sh` reads, and `dws_backfill_state_machine_arn`; and the rest the operator needs |
| `tests/*.tftest.hcl` | Guardrails, IAM, headers, the sign-in and the DWS store, plan-only on mocked providers. The edge function runs as code in `tools/edge-functions.test.ts` (vitest) |

Terraform's version is pinned in `.terraform-version` (tfenv reads it here; CI too).

## Checking it

```
bin/check-infra.sh
```

From the repo root. It copies `infra/` to a temporary directory and runs fmt, validate and the tests there, so it never writes to the checkout and never sees `backend.config` or a tfvars file. `bin/check-infra.sh -filter=tests/iam.tftest.hcl` runs one file.

## Operator steps

One at a time, each when the last is done. The steps by number are the plan's (H0–H14); the order they run in, the feature flag each turns on, and the go-live checks are `docs/hosting.md` § Deploy readiness. Every command is the operator's: Claude never runs anything that touches a credential or a key.

**H1. Bootstrap tfvars.** In `infra-secrets`, from the template, then fill in `project = "ewr-compliance"`, a new `account_email`, `region = "us-east-1"`, `create_subdomain = true`, `parent_domain`, `github_repo`, and `github_subject_prefix` from the second command. Commit and push it: the bootstrap refuses one that isn't.

```
mkdir -p ~/github/infra-secrets/ewr-compliance && cp ~/github/templates/infra/bootstrap/projects/example.tfvars ~/github/infra-secrets/ewr-compliance/bootstrap.tfvars
```

```
gh api repos/Absence0760/ewr-compliance/actions/oidc/customization/sub --jq .sub_claim_prefix
```

**Before H2: the workstation's SSO profiles** (once per workstation; Runbook D in `project-mgmt`'s `docs/runbooks.md`). The bootstrap needs two profiles in `~/.aws/config`: `mgmt`, the organisation's management account, and `dns-parent`, the account that owns the parent zone (`parent_domain`). Add whichever `aws configure list-profiles` doesn't list. Each asks for the SSO start URL and the SSO region: they are the organisation's IAM Identity Center access portal, the address you sign in to AWS through (the management account's Identity Center console shows it under Settings, "AWS access portal URL"), and the region it lives in (`project-mgmt`'s `docs/architecture.md` § IAM Identity Center). Use the same session name for both, so one sign-in covers them. Pick the management account and `AdministratorAccess` for the first:

```
aws configure sso --profile mgmt
```

and the `jaredhoward` account (the parent zone's owner) and `AdministratorAccess` for the second:

```
aws configure sso --profile dns-parent
```

Check each names the account you meant:

```
aws sts get-caller-identity --profile mgmt --query Account --output text && aws sts get-caller-identity --profile dns-parent --query Account --output text
```

**H2. Sign in to the organisation and the parent zone's account.**

```
aws sso login --profile mgmt && aws sso login --profile dns-parent
```

**H3. Create the account** (Runbook A in `project-mgmt`). The plan first, then the real run. Its last stage (`4-github-guardrails`) also changes this repo on GitHub: it creates the `production` environment with you as its required reviewer, which H10 needs, and it locks `main` (a pull request for every change, enforced on admins, the "CI gate" check required, linear history).

```
cd ~/github/templates && ./scripts/new-project-account.sh ewr-compliance --plan
```

```
cd ~/github/templates && ./scripts/new-project-account.sh ewr-compliance
```

The account's details are in the summary it prints at the end: keep the account ID (H4) and the deploy role's ARN (H10) to hand, and record nothing from it in this repo.

Keep the branch protection stage 4 made (the plan's Q5): production deploys `origin/main`, so a change should pass CI before it reaches `main`, not after. Straight after, close issue 1 by its checklist: turn the hook's main-push gate back on (`MAIN_PUSH_GATE = True` in `.claude/hooks/git-scope-guard.py`, `MAIN = "deny"` in its test, and run the test), and put back `CLAUDE.md`'s rule that every change reaches `main` through a PR, in one PR, the first through the gate. Check the lock is there:

```
gh api repos/Absence0760/ewr-compliance/branches/main/protection --jq '.required_status_checks.contexts, .enforce_admins.enabled'
```

It should list `CI gate`, then `true`.

**H4. Enable af-south-1** for the new account, from the management account, then check it reads `ENABLED` (it takes a few minutes). The management account can change another account's regions only once trusted access for AWS Account Management is on in the organisation. Turn it on once (it is harmless if it already is):

```
aws organizations enable-aws-service-access --service-principal account.amazonaws.com --profile mgmt
```

```
aws account enable-region --region-name af-south-1 --account-id <account-id> --profile mgmt
```

```
aws account get-region-opt-status --region-name af-south-1 --account-id <account-id> --profile mgmt
```

If you'd rather not turn trusted access on, do H5 first and enable the region from inside the account instead, then check it the same way without `--account-id`:

```
aws account enable-region --region-name af-south-1 --profile ewr-compliance
```

**H5. SSO access** (Runbook D): assign yourself `AdministratorAccess` on the account in Identity Center, add the profile (the same start URL and session as `mgmt`; pick the `ewr-compliance` account), and check it. Then, signed in to the account's root once, turn on IAM access to billing (Account, IAM user and role access to billing information), which the budgets need. An account the organisation created has no root password: on the root sign-in page, enter the account's email (the plus-addressed `account_email` from H1's `bootstrap.tfvars`: check it matches the email the Organizations console shows for the account), choose "Forgot password", and set one from the mail that arrives. Add an MFA device to root while you are there, then sign out: root goes back to sleep.

```
aws configure sso --profile ewr-compliance
```

```
aws sts get-caller-identity --profile ewr-compliance
```

**H6. First apply (P1).** Write `backend.config`, create `infra-secrets/ewr-compliance/prod.tfvars` from `terraform.tfvars.example` (with `budget_monthly_usd = 20` once H5's billing access is on, and `site_enabled = false`), then init, plan and apply. Look the zone ID up for the tfvars with the third command.

From here on every `terraform` and `aws` command runs as the `ewr-compliance` profile: each command below names it (`AWS_PROFILE=ewr-compliance` before `terraform`, `--profile ewr-compliance` on `aws`), so each works on its own in a new terminal. `tools/deploy.sh`, `tools/dws-stations.sh` and the operator tools use it by default. A command that fails with an expired token needs `aws sso login --profile ewr-compliance` first.

```
cd ~/github/ewr-compliance/infra && printf 'bucket = "ewr-compliance-tfstate-%s"\n' "$(aws sts get-caller-identity --profile ewr-compliance --query Account --output text)" > backend.config
```

```
cd ~/github/ewr-compliance/infra && AWS_PROFILE=ewr-compliance terraform init -backend-config=backend.config
```

```
aws route53 list-hosted-zones-by-name --dns-name <domain> --profile ewr-compliance --query 'HostedZones[0].Id' --output text | sed 's#/hostedzone/##'
```

```
cd ~/github/ewr-compliance/infra && AWS_PROFILE=ewr-compliance terraform plan -var-file=$HOME/github/infra-secrets/ewr-compliance/prod.tfvars -out=prod.tfplan
```

```
cd ~/github/ewr-compliance/infra && AWS_PROFILE=ewr-compliance terraform apply prod.tfplan
```

Then confirm the two SNS subscription emails (one a topic). Exit: the apply is clean and both budgets are listed.

```
aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --profile ewr-compliance --query Account --output text)" --profile ewr-compliance --query 'Budgets[].BudgetName'
```

**H7. The signing key pair, and the site (P2).** Generate the pair in memory-backed storage, outside any repo and off the disk: `$XDG_RUNTIME_DIR` (a tmpfs, `/run/user/<uid>`), or `/dev/shm` without it. On BTRFS (this workstation's file system) `shred` can't overwrite a file in place, so a key written to the home folder can outlive its deletion; a file in RAM is gone once deleted, and at logout or reboot. So do H7 through the signed check in § After a deploy in one sitting: if the file is lost before its private half is in the secret, generate a new pair and put its public half in instead. Generate it, and print the public half:

```
umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${XDG_RUNTIME_DIR:-/dev/shm}/ewr-cf-signing.key" && openssl pkey -in "${XDG_RUNTIME_DIR:-/dev/shm}/ewr-cf-signing.key" -pubout
```

Put the public key in `prod.tfvars` under `cloudfront_public_keys` with a name such as the month (`"2026-11"`), set `site_enabled = true`, then plan and apply as in H6. The certificate validates in the delegated zone, and the distribution takes several minutes. Then put the private key into its secret, from the file:

```
aws secretsmanager put-secret-value --secret-id ewr-compliance/cloudfront-signing-key --secret-string "file://${XDG_RUNTIME_DIR:-/dev/shm}/ewr-cf-signing.key" --region af-south-1 --profile ewr-compliance
```

Keep the file for the signed check in § After a deploy, and delete it there.

**Deploy the sample** (P2's exit), then check the gate.

```
tools/deploy.sh sample
```

### After a deploy

From the repo root. `<domain>` is `domain_name`; `<key-id>` is the key's entry in the first command's output.

```
AWS_PROFILE=ewr-compliance terraform -chdir=infra output signing_public_key_ids
```

An unsigned request is sent to sign-in, and the app's own fetch gets 401:

```
curl -sI https://<domain>/data/index.json | grep -iE '^(HTTP|location)'
```

```
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Requested-With: fetch' https://<domain>/data/index.json
```

A signed one gets 200. This needs H7's key file, so it is the first deploy's check only; later, sign in in a browser instead:

```
curl -s -o /dev/null -w '%{http_code}\n' "$(aws cloudfront sign --url https://<domain>/data/index.json --key-pair-id <key-id> --private-key "file://${XDG_RUNTIME_DIR:-/dev/shm}/ewr-cf-signing.key" --date-less-than "$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)")"
```

Then, the first time, delete the key file: its private half is in the secret, which is the only copy from now on.

```
rm -f "${XDG_RUNTIME_DIR:-/dev/shm}/ewr-cf-signing.key"
```

The same with `https://<domain>/nodes` gives 301 to `/nodes/`, and `https://<domain>/nodes/` gives 200. The map's worker is served as JavaScript:

```
aws s3api list-objects-v2 --bucket "$(AWS_PROFILE=ewr-compliance terraform -chdir=infra output -raw site_bucket)" --prefix _app/immutable/workers/ --profile ewr-compliance --query 'Contents[].Key' --output text
```

```
aws s3api head-object --bucket "$(AWS_PROFILE=ewr-compliance terraform -chdir=infra output -raw site_bucket)" --key <a .mjs key from above> --profile ewr-compliance --query '[ContentType,CacheControl]'
```

It should print `text/javascript` and the immutable cache line.

**Check this first time, and say what it showed:** whether CloudFront runs the viewer-request function before it checks the signature on a trusted-key-group behaviour. AWS's documentation doesn't say. If it checks first, the unsigned curl above gets 403 with the sign-in page (the custom error response) rather than 302: still closed, and still leading to sign-in, but the `?next=` and the 401 JSON don't happen. The sign-in page copes either way: served for a 403, it takes the address it was served at as where to go next.

**H0. Read access to `auth-kit`** (before P3 can be built in CI). As Absence0760/auth-kit#2 says: one fine-grained token limited to `Absence0760/auth-kit`, Contents: Read-only, with its expiry written down, stored in this repo as the Actions secret **and** the Dependabot secret `AUTH_KIT_READ_TOKEN`. Each command prompts for the value:

```
gh secret set AUTH_KIT_READ_TOKEN --repo Absence0760/ewr-compliance --app actions
```

```
gh secret set AUTH_KIT_READ_TOKEN --repo Absence0760/ewr-compliance --app dependabot
```

Until it is set, CI's `server` job warns and passes, and `deploy-lambdas.yml` fails at its preflight.

**H8. Sign-in (P3): apply, then SES production access.** Set `auth_enabled = true` in `prod.tfvars`, then plan and apply as in H6. That makes the table, the API (answering 503 until its code is deployed, H10), its runtime secret and SES. Then check that the domain identity's DKIM is verified (it takes up to a day after the records exist):

```
cd ~/github/ewr-compliance && aws sesv2 get-email-identity --email-identity "$(AWS_PROFILE=ewr-compliance terraform -chdir=infra output -raw ses_identity)" --region af-south-1 --profile ewr-compliance --query 'DkimAttributes.Status'
```

It should print `SUCCESS`. Until production access is granted, SES delivers only to verified addresses, so request it (SES console, af-south-1, Account dashboard, Request production access: transactional mail, sign-in codes to a short list of named users, bounces and complaints suppressed by the configuration set). AWS answers within a day or so. Check it:

```
aws sesv2 get-account --region af-south-1 --profile ewr-compliance --query 'ProductionAccessEnabled'
```

**H10. Deploy the API.** In GitHub, check the `production` environment H3 made has you as its required reviewer, and set its deployment branches and tags to `main` and tags `api@*`. Then set the Actions secret `AWS_DEPLOY_ROLE_ARN` to the bootstrap's `ewr-compliance-deploy` role (the ARN in H3's summary; the command prompts for it), and the variables `AWS_REGION` = `af-south-1` and `API_FUNCTION_NAME` = the second command's output. Then publish a release and approve its deploy:

```
gh secret set AWS_DEPLOY_ROLE_ARN --repo Absence0760/ewr-compliance --app actions
```

```
cd ~/github/ewr-compliance && AWS_PROFILE=ewr-compliance terraform -chdir=infra output -raw api_function_name
```

```
gh variable set AWS_REGION --body af-south-1 --repo Absence0760/ewr-compliance && gh variable set API_FUNCTION_NAME --body ewr-compliance-api --repo Absence0760/ewr-compliance
```

```
gh release create api@0.1.0 --target main --generate-notes --repo Absence0760/ewr-compliance
```

Then `curl -s https://<domain>/api/me` should print the 401 JSON (`"signin":"/signin/"`), not the stub's 503.

**H9. The first admin.** Once the API is deployed and SES is out of the sandbox: install `server/` (needs H0's access over SSH on the workstation), then run the tool, which asks for your address and confirms it:

```
cd ~/github/ewr-compliance/server && pnpm install --frozen-lockfile
```

```
cd ~/github/ewr-compliance && tools/first-admin
```

Sign in at `https://<domain>/` with that address, open Users, and add a second admin, so one locked out can't leave the site without one. `tools/recover-admin` is the break-glass, `tools/clear-lock` clears a sign-in lockout without changing anyone's role, and `tools/erase-user` is the erasure: `docs/hosting.md` § Access control.

**H11. The DWS store (P4).** One at a time, each when the last is done. What each part does, and what its alarms mean: `docs/hosting.md` § The DWS store.

Before step 1: DWS's written permission to store its verified daily flow for this tool, through the client's hydrologist (`docs/hosting.md` § The DWS store). Record it in the private plan, and keep the letter with the client's records, never in this repo. Without it, stop here: the site works without the store, which the app then shows as unavailable.

1. Set `dws_enabled = true` in `prod.tfvars` (and `dws_contact`, a mailbox DWS can write to before blocking us, if you want one in the user agent), then plan and apply as in H6. That makes the bucket, the pipeline (which fails until its code is deployed), the backfill and the empty DWS API key secret. The daily rule is made disabled.
2. Deploy the pipeline as in H10: add the tag rule `pipeline@*` to the `production` environment's deployment branches and tags, set the variable, and publish a release and approve it.

```
gh variable set DWS_FUNCTION_NAME --body ewr-compliance-dws --repo Absence0760/ewr-compliance
```

```
gh release create pipeline@0.1.0 --target main --generate-notes --repo Absence0760/ewr-compliance
```

3. Upload the station list. `tools/deploy.sh real` does it last, after the site; on its own it is below. It says so and does nothing while `dws_enabled` is off, and stops with an error, uploading nothing, if it can't read `terraform output` (sign in again and rerun it):

```
cd ~/github/ewr-compliance && tools/dws-stations.sh
```

4. One pull by hand, from af-south-1, to check DWS answers it with the daily table. It prints counts only (`pulled`, `failed`, `stopped`), never a station. `stopped` = `done` with `failed` = 0 means DWS answered and every page read; `refused` means DWS answered 403, so stop and don't try again until that is understood. After any stop the pipeline itself asks nothing for a while (after a 403 until a run with `"ignoreStop":true` gets through; an hour after the others) and answers `cooling`; adding `"ignoreStop":true` to the payload overrides that, for when you know why.

```
aws lambda invoke --function-name ewr-compliance-dws --cli-binary-format raw-in-base64-out --payload '{"mode":"daily"}' --region af-south-1 --profile ewr-compliance /dev/stdout
```

5. The backfill. Print the plan (date windows only, newest first) into a file, then start it. Pick `--from` for how far back the record should go; it runs one window a minute or so.

```
cd ~/github/ewr-compliance && node tools/dws-backfill-plan.mjs --from 1990-01-01 > ~/dws-backfill.json
```

```
cd ~/github/ewr-compliance && aws stepfunctions start-execution --state-machine-arn "$(AWS_PROFILE=ewr-compliance terraform -chdir=infra output -raw dws_backfill_state_machine_arn)" --input file://$HOME/dws-backfill.json --region af-south-1 --profile ewr-compliance
```

If it fails (the `dws-backfill-failed` alarm), the failed window's error is the execution's. Nothing in it is retried that would ask DWS again: start the same command again to resume once the reason is understood (not straight after `DwsRefused`). It skips what is stored.

6. Turn the daily pull on: `dws_schedule_enabled = true` in `prod.tfvars`, then plan and apply. That also makes the lag alarm.

7. When DWS issues an API key: write it alone to a file in memory-backed storage, as for H7's key (`${XDG_RUNTIME_DIR:-/dev/shm}/dws-api-key.txt`), put it into its secret from the file, and delete the file. Nothing reads it yet (the HyData page needs none); the pipeline's API source is a later change.

```
aws secretsmanager put-secret-value --secret-id ewr-compliance/dws-api-key --secret-string "file://${XDG_RUNTIME_DIR:-/dev/shm}/dws-api-key.txt" --region af-south-1 --profile ewr-compliance
```

```
rm -f "${XDG_RUNTIME_DIR:-/dev/shm}/dws-api-key.txt"
```

**H12. The privacy notice and the client's consent.** In the private repo, fill the placeholders of `static/data/privacy.md` and of `docs/hosting-consent.md` with the same values, run `pnpm test:private` here (its periods are pinned to the code), and send the client the consent text. Keep the reply in the plan.

**H13. Go live.** Once the client agrees, deploy the real data, then run every check in `docs/hosting.md` § Deploy readiness, Go-live checks.

```
cd ~/github/ewr-compliance && tools/deploy.sh real
```

**H14. Registry.** Add the project's rows to `project-mgmt` (`docs/vendor-accounts.md`, `docs/architecture.md`) and to `templates`' `docs/estate-map.md`.

## Rotating the signing key

Add the new public key to `cloudfront_public_keys` under a new name, keep the old one, set `cloudfront_signing_key` to the old name, and apply: the key group trusts both, and the API still signs with the old. Then, one straight after the other, put the new private key into the secret (H7's command), set `cloudfront_signing_key` to the new name and apply: the API's environment changes, so every instance starts again, reads the new key and checks it against the new public key (an instance that starts in between refuses sign-in with 503 for that minute rather than sign with a mismatched pair). Once every cookie signed with the old key has expired (15 minutes), remove the old public key, unset `cloudfront_signing_key`, and apply again.

## Rotating the API's keys

`terraform apply -replace=random_password.auth_session_key` signs everyone out; `-replace=random_password.auth_code_key` forgets live codes and lockouts; `-replace=random_password.api_origin_secret` changes the header CloudFront stamps. Each rewrites the runtime secret in the same apply, and the API starts again on the new value.

## Costs

About $11–13 a month in all once P3 and P4 are in: WAF about $7, Secrets Manager $0.40 a secret (the signing key, the API's runtime secret and the DWS API key), the sops key $1, alarms about $0.10 each past the free ten, Route 53 $0.50 for the zone. The budgets are free (two an account).
