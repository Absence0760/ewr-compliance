variable "aws_region" {
  description = <<-EOT
    The workload region: the site bucket, the signing-key secret and, later,
    the Lambdas, the user table and the DWS store. No default on purpose.
    af-south-1 (Cape Town) is the decision: DWS answers only South African
    networks, and the water data, the user list and the sign-in stay in South
    Africa. It is an opt-in region that must be enabled on the account first
    (infra/README.md, H4). The certificate, the WAF and the CloudFront alarms
    are in us-east-1 whatever this is.

    The privacy notice and the client's consent say data is stored in South
    Africa, so any other region is refused unless data_outside_south_africa is
    set, which must only happen with both rewritten (POPIA s72).
  EOT
  type        = string

  validation {
    condition     = var.aws_region == "af-south-1" || var.data_outside_south_africa
    error_message = "The privacy notice says data is stored in South Africa (af-south-1). To deploy elsewhere, change the notice and the client's consent first, then set data_outside_south_africa = true."
  }
}

variable "data_outside_south_africa" {
  description = "Deliberately host outside af-south-1 (Cape Town). Only with the privacy notice rewritten to say where data is stored, and the client's agreement (POPIA s72)."
  type        = bool
  default     = false
}

variable "github_repo" {
  description = "This repository, as owner/name. A tag on every resource, and the subject the deploy role's trust must name (oidc.tf)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "github_repo is owner/name, as in the repository's URL."
  }
}

variable "bootstrap_slug" {
  description = "The slug new-project-account.sh was run with. oidc.tf looks up the role `<slug>-deploy`; a mismatch fails the plan with \"role not found\"."
  type        = string
  default     = "ewr-compliance"
}

variable "domain_name" {
  description = "The site's hostname: the delegated child zone that route53_zone_id names. The certificate, the distribution's alias and its DNS records use it. Set in infra-secrets, never in this repo."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name is a lowercase hostname, with no scheme, path or trailing dot."
  }
}

variable "route53_zone_id" {
  description = "ID of the Route 53 zone for domain_name, created and delegated by the bootstrap (create_subdomain = true). Terraform adds records to it and never creates or destroys it. aws route53 list-hosted-zones-by-name --dns-name <domain_name> --profile ewr-compliance"
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]{5,31}$", var.route53_zone_id))
    error_message = "route53_zone_id is a Route 53 hosted zone ID (Z…)."
  }
}

# --- Alerts and cost (alarms.tf) ---------------------------------------------

# Checked the same way as WM's: a plausible address, and not at a name
# RFC 2606 / RFC 6761 reserve, so a tfvars copied from the example unedited
# pages nobody and fails here instead.
variable "budget_alert_email" {
  description = "The mailbox both alert topics send to: budgets, cost anomalies and alarms. Required: without it nothing pages anyone. Set in infra-secrets, never in this repo."
  type        = string

  validation {
    condition = (
      can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$", var.budget_alert_email)) &&
      !can(regex("(?i)(@([^@]+\\.)?example\\.(com|org|net)|\\.(example|test|invalid|localhost))$", var.budget_alert_email))
    )
    error_message = "budget_alert_email must be a real mailbox (name@domain.tld), not at a reserved domain (example.com/.org/.net, .example, .test, .invalid, .localhost)."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly AWS spend ceiling in USD: ACTUAL 80%, ACTUAL 100% and FORECASTED 100% to the us-east-1 topic. The plan's estimate is about $11-13 a month, so 20 keeps ACTUAL 80% ($16) above it. 0 skips both budgets, only until IAM access to billing is on (H5)."
  type        = number
  default     = 20

  validation {
    condition     = var.budget_monthly_usd >= 0
    error_message = "budget_monthly_usd must be 0 (no budgets) or a positive USD amount."
  }
}

variable "budget_daily_usd" {
  description = "Daily spend ceiling in USD (ACTUAL 100%, at most one mail a day): the first month's guard, before the monthly forecast has history. null derives it, ceil(budget_monthly_usd x 2.25 / 30): $2 on $20. 0 skips only the daily budget."
  type        = number
  default     = null

  validation {
    condition = var.budget_daily_usd == null ? true : (
      var.budget_daily_usd == 0 || (var.budget_daily_usd > 0 && var.budget_daily_usd < var.budget_monthly_usd)
    )
    error_message = "budget_daily_usd must be null (derived), 0 (no daily budget), or a positive amount below budget_monthly_usd."
  }
}

variable "cost_anomaly_threshold_usd" {
  description = "Cost Anomaly Detection (free): anomalies with a total impact of at least this many USD page the us-east-1 topic. 0 (off) by default: an account holds one services monitor and AWS may have made one, which would fail the first apply. Turn it on after the first apply (5 is sensible here)."
  type        = number
  default     = 0

  validation {
    condition     = var.cost_anomaly_threshold_usd >= 0
    error_message = "cost_anomaly_threshold_usd must be 0 (off) or a positive USD amount."
  }
}

variable "alarms_enabled" {
  description = "Create the CloudWatch alarms (CloudFront 5xx and request flood, WAF blocks). Each past the organisation's shared ten free costs about $0.10 a month. Budgets are not alarms and are unaffected."
  type        = bool
  default     = true
}

variable "cloudfront_requests_alarm_per_5min" {
  description = "Alarm when CloudFront serves more than this many requests in 5 minutes. A page load is about 30-60 requests, so 3000 is many times a busy 5 minutes for a handful of users."
  type        = number
  default     = 3000

  validation {
    condition     = var.cloudfront_requests_alarm_per_5min >= 500 && var.cloudfront_requests_alarm_per_5min <= 20000
    error_message = "Between 500 and 20000."
  }
}

# --- Deploy role (oidc.tf) ---------------------------------------------------

variable "deploy_lambda_functions" {
  description = "More Lambda functions CI may update the code of, through the bootstrap deploy role. The API (auth.tf) and the DWS pipeline (dws.tf) are added by themselves when auth_enabled and dws_enabled. With none, the deploy policy isn't created at all. The role never gets S3 write: the data goes up only from the workstation (tools/deploy.sh)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.deploy_lambda_functions : can(regex("^ewr-compliance-[a-z0-9-]+$", n))])
    error_message = "Each name is one of this project's functions: ewr-compliance-<name>, lowercase. No wildcards."
  }
}

# --- Site (site.tf, edge_functions.tf, security_headers.tf, waf.tf) ----------

variable "site_enabled" {
  description = "Create the gated site: the private bucket, the certificate, the distribution, its WAF and the signing-key secret (P2). Off by default, so P1's skeleton applies before the CloudFront key pair exists (infra/README.md, H7)."
  type        = bool
  default     = false
}

variable "cloudfront_public_keys" {
  description = <<-EOT
    The public halves (PEM) of the CloudFront key pairs that sign the session
    cookies, by a name you choose, such as the month made: { "2026-11" = <<-EOT … }.
    Every key here is trusted by the key group, so a rotation adds the new key,
    moves the signer to it, then drops the old one. The private half goes only
    into the signing-key secret (H7), never here. Public keys are not secret,
    but this lives in infra-secrets with the rest of the tfvars. Required, at
    least one, when site_enabled.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([for k, pem in var.cloudfront_public_keys :
      can(regex("^[A-Za-z0-9-]{1,40}$", k)) &&
      can(regex("^-----BEGIN PUBLIC KEY-----\\n[A-Za-z0-9+/=\\n]+\\n-----END PUBLIC KEY-----$", trimspace(pem)))
    ])
    error_message = "Each entry is a short name (letters, digits, '-') mapped to a PEM public key (openssl rsa -pubout)."
  }
  validation {
    condition     = !var.site_enabled || length(var.cloudfront_public_keys) > 0
    error_message = "site_enabled needs at least one cloudfront_public_keys entry: the default behaviour trusts only that key group, and a key group can't be empty (H7)."
  }
}

variable "waf_site_rate_limit_per_ip" {
  description = "WAF limit on every path: requests per IP per 5-minute window. A page load is about 30-60 requests. AWS's minimum is 100."
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_site_rate_limit_per_ip >= 100
    error_message = "AWS WAF's rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "waf_auth_rate_limit_per_ip" {
  description = "WAF limit on /api/auth/*: requests per IP per 5-minute window, below anything a person signing in reaches. AWS's minimum is 100; at most the site-wide limit, which counts these too."
  type        = number
  default     = 100

  validation {
    condition     = var.waf_auth_rate_limit_per_ip >= 100 && var.waf_auth_rate_limit_per_ip <= var.waf_site_rate_limit_per_ip
    error_message = "Between 100 (AWS WAF's minimum) and waf_site_rate_limit_per_ip."
  }
}

# --- Sign-in and users (auth.tf) ---------------------------------------------

variable "auth_enabled" {
  description = "Create the sign-in (P3): the user table, the API Lambda behind /api/*, its runtime secret, SES and their alarms. Needs site_enabled. Off by default, so the site can be checked with signed URLs first (H7)."
  type        = bool
  default     = false

  validation {
    condition     = !var.auth_enabled || var.site_enabled
    error_message = "auth_enabled needs site_enabled: the API signs the site's cookies and sits behind its distribution."
  }
}

variable "cloudfront_signing_key" {
  description = "The cloudfront_public_keys entry whose private half is in the signing-key secret, and which the API signs with. Empty takes the only entry; set it when there are two (during a rotation)."
  type        = string
  default     = ""

  validation {
    condition     = var.cloudfront_signing_key == "" || contains(keys(var.cloudfront_public_keys), var.cloudfront_signing_key)
    error_message = "cloudfront_signing_key names an entry of cloudfront_public_keys."
  }
}

variable "mail_from_local_part" {
  description = "The sign-in email's sender: <this>@domain_name. The API may send as this address only (ses:FromAddress)."
  type        = string
  default     = "no-reply"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{0,63}$", var.mail_from_local_part))
    error_message = "A lowercase local part, such as no-reply."
  }
}

variable "mail_from_subdomain" {
  description = "The custom MAIL FROM subdomain (<this>.domain_name), for SPF alignment."
  type        = string
  default     = "mail"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.mail_from_subdomain))
    error_message = "One lowercase DNS label."
  }
}

variable "dmarc_policy" {
  description = "The DMARC policy: none to start, quarantine or reject once DKIM and SPF are seen to pass."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "none, quarantine or reject."
  }
}

variable "dmarc_report_email" {
  description = "Where DMARC aggregate reports go (rua). Empty sends none. Set in infra-secrets, never in this repo."
  type        = string
  default     = ""

  validation {
    condition     = var.dmarc_report_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$", var.dmarc_report_email))
    error_message = "Empty, or a mailbox."
  }
}

variable "ses_tls_policy" {
  description = "REQUIRE: SES refuses to hand a sign-in code to a mail server that can't do TLS. OPTIONAL sends in the clear to such servers."
  type        = string
  default     = "REQUIRE"

  validation {
    condition     = contains(["REQUIRE", "OPTIONAL"], var.ses_tls_policy)
    error_message = "REQUIRE or OPTIONAL."
  }
}

variable "api_log_retention_days" {
  description = "Days the API's logs are kept. They hold event names and opaque ids, never an address."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731], var.api_log_retention_days)
    error_message = "One of CloudWatch's retention periods, up to 731 days."
  }
}

variable "api_reserved_concurrency" {
  description = "Reserved concurrency for the API, which also caps it. null (the default) reserves none: a new account's limit can be 10, all of which must stay unreserved. Set it (5 is plenty) once the account's limit is raised."
  type        = number
  default     = null

  validation {
    condition     = var.api_reserved_concurrency == null ? true : (var.api_reserved_concurrency >= 1 && var.api_reserved_concurrency <= 50)
    error_message = "null, or between 1 and 50."
  }
}

# --- DWS store (dws.tf, dws_backfill.tf) -------------------------------------

variable "dws_enabled" {
  description = "Create the DWS store (P4): its bucket, the pipeline Lambda and its DLQ, the empty DWS API key secret, the backfill state machine, their alarms, and with site_enabled the signed /dws/* behaviour. Off by default. The daily pulls stay off until dws_schedule_enabled."
  type        = bool
  default     = false
}

variable "dws_schedule_enabled" {
  description = "Turn the daily pull on: the EventBridge rule's state, and the lag alarm with it. Off until the pipeline's code is deployed, the station list uploaded and the backfill done (all H11), so the rule never runs the stub and the lag alarm doesn't fire from the first apply."
  type        = bool
  default     = false

  validation {
    condition     = !var.dws_schedule_enabled || var.dws_enabled
    error_message = "dws_schedule_enabled needs dws_enabled: the rule runs the pipeline Lambda."
  }
}

variable "dws_contact" {
  description = "A mailbox the pipeline names in its User-Agent, so DWS can write before blocking us. Optional: empty sends the project's URL only. Set in infra-secrets, never in this repo."
  type        = string
  default     = ""

  validation {
    condition     = var.dws_contact == "" || can(regex("^[^@\\s<>()]+@[^@\\s<>()]+\\.[^@\\s<>().]+$", var.dws_contact))
    error_message = "dws_contact is empty or a mailbox (name@domain.tld)."
  }
}

variable "dws_lag_alarm_days" {
  description = "Alarm when the oldest listed station's last current pull is more than this many days old, or the daily run published no lag for two days. The pipeline marks a station stale after 3 days (pipeline/src/run.ts STALE_AFTER_DAYS)."
  type        = number
  default     = 3

  validation {
    condition     = var.dws_lag_alarm_days >= 1 && var.dws_lag_alarm_days <= 30
    error_message = "Between 1 and 30 days."
  }
}

variable "dws_backfill_wait_seconds" {
  description = "The backfill's pause after each window. A window is one request a station, a second apart, so 60 keeps DWS's load from a backfill near that of the daily run."
  type        = number
  default     = 60

  validation {
    condition     = var.dws_backfill_wait_seconds >= 30 && var.dws_backfill_wait_seconds <= 3600
    error_message = "Between 30 and 3600 seconds."
  }
}

variable "dws_log_retention_days" {
  description = "Days the pipeline's logs are kept. They name a station only beside a failed page's fixed label."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731], var.dws_log_retention_days)
    error_message = "One of CloudWatch's retention periods, up to 731 days."
  }
}
