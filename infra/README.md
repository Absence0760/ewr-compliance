# infra

Terraform for hosting EWR Compliance on AWS: the account skeleton (P1) and the gated static site (P2) of the private hosting plan. Sign-in (P3) and the DWS store (P4) add their own files here later. Built after `project-water-management`'s `infra/`.

Nothing here is applied by CI. The operator plans and applies from the workstation, with their own SSO profile. CI runs `bin/check-infra.sh` only: `terraform fmt`, `validate`, and the plan-only tests in `tests/` against mocked providers, with no credentials.

This repo is public. The account ID stays in `backend.config` (gitignored), and the values (domain, zone, alert mailbox, public keys) in `infra-secrets/ewr-compliance/prod.tfvars`. `terraform.tfvars.example` shows the shape with placeholders.

## Files

| File | What it makes |
|---|---|
| `main.tf` | Providers: `var.aws_region` (af-south-1) and a `us_east_1` alias for CloudFront's certificate, WAF and metrics, and for budgets. `default_tags` on both. The S3 backend, its bucket from `backend.config` |
| `variables.tf` | Every input. `aws_region` is refused unless it is af-south-1 or `data_outside_south_africa = true`. Feature flags (`site_enabled`, `api_origin_host`, `deploy_lambda_functions`, `cost_anomaly_threshold_usd`) are off by default |
| `oidc.tf` | Looks up the bootstrap's `ewr-compliance-deploy` role, refuses a trust wider than this repo's `production` environment, and attaches a policy only once there are Lambdas to update. The role never gets S3 or CloudFront: the site and data go up from the workstation only |
| `alarms.tf` | Alert topics in af-south-1 and us-east-1, mailing `budget_alert_email`; monthly and daily budgets; Cost Anomaly Detection (off until turned on); the CloudFront 5xx and request-flood alarms |
| `site.tf` | With `site_enabled`: the private bucket (versioned, old versions kept 30 days), OAC, the us-east-1 certificate validated in the delegated zone, the key group from `cloudfront_public_keys`, the empty signing-key secret, the distribution (PriceClass_All; default behaviour signed; `/signin/*` unsigned; `/api/*` once `api_origin_host` is set) and its DNS records |
| `edge_functions.tf` | The viewer-request function: unsigned or expired requests get a 302 to `/signin/` (or 401 JSON with `X-Requested-With`), folder paths get `index.html` |
| `security_headers.tf` | The response-headers policies: what `static/_headers` set on Pages, plus HSTS |
| `waf.tf` | Per-IP rate limits, `/api/auth/*` and every path, and the blocked-requests alarm |
| `outputs.tf` | `site_bucket` and `distribution_id`, which `tools/deploy.sh` reads, and the rest the operator needs |
| `tests/*.tftest.hcl` | Guardrails, IAM and headers, plan-only on mocked providers. The edge function runs as code in `tools/edge-functions.test.ts` (vitest) |

Terraform's version is pinned in `.terraform-version` (tfenv reads it here; CI too).

## Checking it

```
bin/check-infra.sh
```

From the repo root. It copies `infra/` to a temporary directory and runs fmt, validate and the tests there, so it never writes to the checkout and never sees `backend.config` or a tfvars file. `bin/check-infra.sh -filter=tests/iam.tftest.hcl` runs one file.

## Operator steps

One at a time, each when the last is done. The steps by number are the plan's (H1–H7). Every command is the operator's: Claude never runs anything that touches a credential or a key.

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

**Check this first time, and say what it showed:** whether CloudFront runs the viewer-request function before it checks the signature on a trusted-key-group behaviour. AWS's documentation doesn't say. If it checks first, the unsigned curl above gets 403 with the sign-in page (the custom error response) rather than 302: still closed, and still leading to sign-in, but the `?next=` and the 401 JSON don't happen, and P3's sign-in must not rely on them.

## Rotating the signing key

Add the new public key to `cloudfront_public_keys` under a new name, keep the old one, and apply. Put the new private key into the secret (H7's command). Once every session signed with the old key has expired (15 minutes; P3 refreshes them), remove the old public key and apply again.

## Costs

About $11–13 a month in all once P3 and P4 are in: WAF about $7, Secrets Manager $0.40 a secret, the sops key $1, alarms about $0.10 each past the free ten, Route 53 $0.50 for the zone. The budgets are free (two an account).
