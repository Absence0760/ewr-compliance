# infra

Terraform for hosting EWR Compliance on AWS: the account skeleton (P1), the gated static site (P2) and the sign-in (P3) of the private hosting plan. The DWS store (P4) adds its own files. Built after `project-water-management`'s `infra/`.

Nothing here is applied by CI. The operator plans and applies from the workstation, with their own SSO profile. CI runs `bin/check-infra.sh` only: `terraform fmt`, `validate`, and the plan-only tests in `tests/` against mocked providers, with no credentials.

This repo is public. The account ID stays in `backend.config` (gitignored), and the values (domain, zone, alert mailbox, public keys) in `infra-secrets/ewr-compliance/prod.tfvars`. `terraform.tfvars.example` shows the shape with placeholders.

## Files

| File | What it makes |
|---|---|
| `main.tf` | Providers: `var.aws_region` (af-south-1) and a `us_east_1` alias for CloudFront's certificate, WAF and metrics, and for budgets. `default_tags` on both. The S3 backend, its bucket from `backend.config` |
| `variables.tf` | Every input. `aws_region` is refused unless it is af-south-1 or `data_outside_south_africa = true`. Feature flags (`site_enabled`, `auth_enabled`, `deploy_lambda_functions`, `cost_anomaly_threshold_usd`) are off by default |
| `oidc.tf` | Looks up the bootstrap's `ewr-compliance-deploy` role, refuses a trust wider than this repo's `production` environment, and attaches a policy only once there are Lambdas to update (the API, by itself, once `auth_enabled`), for their code only. The role never gets S3 or CloudFront: the site and data go up from the workstation only |
| `alarms.tf` | Alert topics in af-south-1 and us-east-1, mailing `budget_alert_email`; monthly and daily budgets; Cost Anomaly Detection (off until turned on); the CloudFront 5xx and request-flood alarms |
| `site.tf` | With `site_enabled`: the private bucket (versioned, old versions kept 30 days), OAC, the us-east-1 certificate validated in the delegated zone, the key group from `cloudfront_public_keys`, the empty signing-key secret, the distribution (PriceClass_All; default behaviour signed; `/signin/*` unsigned; `/api/*` to the API once `auth_enabled`) and its DNS records |
| `edge_functions.tf` | The viewer-request function: unsigned or expired requests get a 302 to `/signin/` (or 401 JSON with `X-Requested-With`), folder paths get `index.html` |
| `security_headers.tf` | The response-headers policies: what `static/_headers` set on Pages, plus HSTS |
| `waf.tf` | Per-IP rate limits, `/api/auth/*` and every path, and the blocked-requests alarm |
| `auth.tf` | With `auth_enabled` (P3): the user table (`auth-kit`'s single table: PITR, TTL on `ttl`, deletion protection), the API Lambda (stub code, which CI replaces) and its Function URL, its runtime secret (the code and session keys and the origin secret, `random_password`s written write-only), its role (`auth-kit`'s actions on the table, SES as `no-reply@` only, its two secrets, its log group), SES (configuration set, DKIM, MAIL FROM, DMARC), and the API-error, bounce, complaint and `auth.locked` alarms |
| `outputs.tf` | `site_bucket` and `distribution_id`, which `tools/deploy.sh` reads; `users_table` and `auth_runtime_secret_arn`, which the operator tools read; and the rest the operator needs |
| `tests/*.tftest.hcl` | Guardrails, IAM, headers and the sign-in, plan-only on mocked providers. The edge function runs as code in `tools/edge-functions.test.ts` (vitest) |

Terraform's version is pinned in `.terraform-version` (tfenv reads it here; CI too).

## Checking it

```
bin/check-infra.sh
```

From the repo root. It copies `infra/` to a temporary directory and runs fmt, validate and the tests there, so it never writes to the checkout and never sees `backend.config` or a tfvars file. `bin/check-infra.sh -filter=tests/iam.tftest.hcl` runs one file.

## Operator steps

One at a time, each when the last is done. The steps by number are the plan's (H0–H10). Every command is the operator's: Claude never runs anything that touches a credential or a key.

**H1. Bootstrap tfvars.** In `infra-secrets`, from the template, then fill in `project = "ewr-compliance"`, a new `account_email`, `region = "us-east-1"`, `create_subdomain = true`, `parent_domain`, `github_repo`, and `github_subject_prefix` from the second command. Commit and push it: the bootstrap refuses one that isn't.

```
mkdir -p ~/github/infra-secrets/ewr-compliance && cp ~/github/templates/infra/bootstrap/projects/example.tfvars ~/github/infra-secrets/ewr-compliance/bootstrap.tfvars
```

```
gh api repos/Absence0760/ewr-compliance/actions/oidc/customization/sub --jq .sub_claim_prefix
```

**H2. Sign in to the organisation and the parent zone's account.**

```
aws sso login --profile mgmt && aws sso login --profile dns-parent
```

**H3. Create the account** (Runbook A in `project-mgmt`). The plan first, then the real run.

```
cd ~/github/templates && ./scripts/new-project-account.sh ewr-compliance --plan
```

```
cd ~/github/templates && ./scripts/new-project-account.sh ewr-compliance
```

**H4. Enable af-south-1** for the new account, from the management account, then check it reads `ENABLED` (it takes a few minutes).

```
aws account enable-region --region-name af-south-1 --account-id <account-id> --profile mgmt
```

```
aws account get-region-opt-status --region-name af-south-1 --account-id <account-id> --profile mgmt
```

**H5. SSO access** (Runbook D): assign yourself `AdministratorAccess` on the account in Identity Center, add the profile, and check it. Then, signed in to the account's root once, turn on IAM access to billing (Account, IAM user and role access to billing information), which the budgets need.

```
aws configure sso --profile ewr-compliance
```

```
aws sts get-caller-identity --profile ewr-compliance
```

**H6. First apply (P1).** Write `backend.config`, create `infra-secrets/ewr-compliance/prod.tfvars` from `terraform.tfvars.example` (with `budget_monthly_usd = 20` once H5's billing access is on, and `site_enabled = false`), then init, plan and apply. Look the zone ID up for the tfvars with the third command.

```
cd ~/github/ewr-compliance/infra && printf 'bucket = "ewr-compliance-tfstate-%s"\n' "$(aws sts get-caller-identity --profile ewr-compliance --query Account --output text)" > backend.config
```

```
cd ~/github/ewr-compliance/infra && AWS_PROFILE=ewr-compliance terraform init -backend-config=backend.config
```

```
aws route53 list-hosted-zones-by-name --dns-name <domain> --profile ewr-compliance --query 'HostedZones[0].Id' --output text
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

**H7. The signing key pair, and the site (P2).** Generate the pair outside any repo, and print the public half.

```
umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/ewr-cf-signing.key && openssl pkey -in ~/ewr-cf-signing.key -pubout
```

Put the public key in `prod.tfvars` under `cloudfront_public_keys` with a name such as the month (`"2026-11"`), set `site_enabled = true`, then plan and apply as in H6. The certificate validates in the delegated zone, and the distribution takes several minutes. Then put the private key into its secret, from the file:

```
aws secretsmanager put-secret-value --secret-id ewr-compliance/cloudfront-signing-key --secret-string file://$HOME/ewr-cf-signing.key --region af-south-1 --profile ewr-compliance
```

Keep the file only for the signed check below, then delete it:

```
shred -u ~/ewr-cf-signing.key
```

**Deploy the sample** (P2's exit), then check the gate.

```
tools/deploy.sh sample
```

### After a deploy

From the repo root. `<domain>` is `domain_name`; `<key-id>` is the key's entry in `terraform output signing_public_key_ids`.

An unsigned request is sent to sign-in, and the app's own fetch gets 401:

```
curl -sI https://<domain>/data/index.json | grep -iE '^(HTTP|location)'
```

```
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Requested-With: fetch' https://<domain>/data/index.json
```

A signed one gets 200 (with the key file from H7, before deleting it):

```
curl -s -o /dev/null -w '%{http_code}\n' "$(aws cloudfront sign --url https://<domain>/data/index.json --key-pair-id <key-id> --private-key file://$HOME/ewr-cf-signing.key --date-less-than "$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)")"
```

The same with `https://<domain>/nodes` gives 301 to `/nodes/`, and `https://<domain>/nodes/` gives 200. The map's worker is served as JavaScript:

```
aws s3api list-objects-v2 --bucket "$(terraform -chdir=infra output -raw site_bucket)" --prefix _app/immutable/workers/ --profile ewr-compliance --query 'Contents[].Key' --output text
```

```
aws s3api head-object --bucket "$(terraform -chdir=infra output -raw site_bucket)" --key <a .mjs key from above> --profile ewr-compliance --query '[ContentType,CacheControl]'
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
aws sesv2 get-email-identity --email-identity "$(terraform -chdir=infra output -raw ses_identity)" --region af-south-1 --profile ewr-compliance --query 'DkimAttributes.Status'
```

It should print `SUCCESS`. Until production access is granted, SES delivers only to verified addresses, so request it (SES console, af-south-1, Account dashboard, Request production access: transactional mail, sign-in codes to a short list of named users, bounces and complaints suppressed by the configuration set). AWS answers within a day or so. Check it:

```
aws sesv2 get-account --region af-south-1 --profile ewr-compliance --query 'ProductionAccessEnabled'
```

**H10. Deploy the API.** In GitHub, set the `production` environment's required reviewer (you) and its deployment branches to `main` and tags `api@*`; the Actions secret `AWS_DEPLOY_ROLE_ARN` (the bootstrap's `ewr-compliance-deploy` role); and the variables `AWS_REGION` = `af-south-1` and `API_FUNCTION_NAME` = the first command's output. Then publish a release and approve its deploy:

```
terraform -chdir=infra output -raw api_function_name
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

Sign in at `https://<domain>/` with that address, open Users, and add a second admin, so one locked out can't leave the site without one. `tools/recover-admin` is the break-glass and `tools/erase-user` the erasure: `docs/hosting.md` § Access control.

## Rotating the signing key

Add the new public key to `cloudfront_public_keys` under a new name, keep the old one, set `cloudfront_signing_key` to the old name, and apply: the key group trusts both, and the API still signs with the old. Then, one straight after the other, put the new private key into the secret (H7's command), set `cloudfront_signing_key` to the new name and apply: the API's environment changes, so every instance starts again, reads the new key and checks it against the new public key (an instance that starts in between refuses sign-in with 503 for that minute rather than sign with a mismatched pair). Once every cookie signed with the old key has expired (15 minutes), remove the old public key, unset `cloudfront_signing_key`, and apply again.

## Rotating the API's keys

`terraform apply -replace=random_password.auth_session_key` signs everyone out; `-replace=random_password.auth_code_key` forgets live codes and lockouts; `-replace=random_password.api_origin_secret` changes the header CloudFront stamps. Each rewrites the runtime secret in the same apply, and the API starts again on the new value.

## Costs

About $11–13 a month in all once P3 and P4 are in: WAF about $7, Secrets Manager $0.40 a secret (the signing key and the API's runtime secret), the sops key $1, alarms about $0.10 each past the free ten, Route 53 $0.50 for the zone. The budgets are free (two an account).
