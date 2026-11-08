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

# --- Spend breaker (breaker.tf) -----------------------------------------------
# Each trip stops one function (its reserved concurrency to 0) until the
# operator resets it. Prices: af-south-1 Lambda arm64 $0.00001768 a GB-second
# and $0.27 a million requests (docs/hosting.md § Cost controls). A month is
# 2 592 000 s. The bounds keep a trip both above the function's legitimate
# peak and below a monthly cost that matters.

variable "breaker_api_concurrency" {
  description = "Trip the API (reserved concurrency to 0) when it holds this many copies busy in each of 3 consecutive 5-minute periods. A handful of people make one call at a time each; a sign-in step takes its 1-second floor. At saturation (10 copies, the account's limit) it trips in about 15 minutes, having spent at most 10 x 900 s x 0.25 GB x $0.00001768 = $0.04. At least 2, and at most the API's cap (api_reserved_concurrency, else lambda_account_concurrency_limit): above it the alarm could never fire."
  type        = number
  default     = 4

  validation {
    condition     = var.breaker_api_concurrency >= 2 && var.breaker_api_concurrency <= (var.api_reserved_concurrency == null ? var.lambda_account_concurrency_limit : var.api_reserved_concurrency)
    error_message = "breaker_api_concurrency must be at least 2 and at most api_reserved_concurrency (or, with none, lambda_account_concurrency_limit): above the cap the metric can't reach it."
  }
}

variable "breaker_api_duration_ms_per_hour" {
  description = <<-EOT
    Trip the API when its billed Duration over a clock hour passes this many
    milliseconds. 3 600 000 is one copy busy the whole hour, against a handful
    of people's few seconds a page. Under it all month: 3 600 000 ms x 720 h =
    2 592 000 s x 0.25 GB x $0.00001768 = $11.46.
  EOT
  type        = number
  default     = 3600000

  validation {
    condition     = var.breaker_api_duration_ms_per_hour >= 1800000 && var.breaker_api_duration_ms_per_hour <= 7200000
    error_message = "breaker_api_duration_ms_per_hour must be 1 800 000-7 200 000 (half a copy to two copies busy the whole hour; at most $22.91 a month)."
  }
}

variable "breaker_api_invocations_per_5min" {
  description = "Trip the API when it runs more than this many times in each of 3 consecutive 5-minute periods: a flood of fast calls, which bills requests and log lines but almost no Duration. 3 000 is 10 a second for 15 minutes on end, against a handful of people's tens per 5 minutes (it replaced the mail-only api-invocations alarm, and mails as it trips). Under it all month: 25.92 M x $0.27 per million = $7.00, plus about $7.40 of log lines."
  type        = number
  default     = 3000

  validation {
    condition     = var.breaker_api_invocations_per_5min >= 600 && var.breaker_api_invocations_per_5min <= 6000
    error_message = "breaker_api_invocations_per_5min must be 600-6 000 (2-20 calls a second sustained)."
  }
}

variable "breaker_dws_concurrency" {
  description = "Trip the DWS pipeline when it holds this many copies busy in each of 3 consecutive 5-minute periods. The lease lets one run work at a time and any other ends at once with LeaseBusy, so a legitimate moment holds 2 at most (the backfill's window and the daily run, or a pull by hand), never for 15 minutes. At least 3 for that reason, and at most lambda_account_concurrency_limit."
  type        = number
  default     = 3

  validation {
    condition     = var.breaker_dws_concurrency >= 3 && var.breaker_dws_concurrency <= var.lambda_account_concurrency_limit
    error_message = "breaker_dws_concurrency must be at least 3 (the lease's legitimate 2 at a moment) and at most lambda_account_concurrency_limit."
  }
}

variable "breaker_dws_duration_ms_per_hour" {
  description = <<-EOT
    Trip the DWS pipeline when its billed Duration over a clock hour passes
    this many milliseconds. A backfill holds one copy busy the whole hour at
    most (a window up to 900 s, then dws_backfill_wait_seconds), and the
    lease stops any second run within a second. Lambda dates a run's
    Duration at its start, so a run begun in the hour's last second counts
    its whole 900 s there: a legitimate hour sums 3 600 000 + 900 000 =
    4 500 000 ms at most. 5 400 000 (1.5 copies) leaves 900 000 over that.
    Under it all month:
    5 400 000 ms x 720 h = 3 888 000 s x 0.25 GB x $0.00001768 = $17.19.
  EOT
  type        = number
  default     = 5400000

  validation {
    condition     = var.breaker_dws_duration_ms_per_hour > 4500000 && var.breaker_dws_duration_ms_per_hour <= 14400000
    error_message = "breaker_dws_duration_ms_per_hour must be above 4 500 000 (a backfill's busiest hour: one copy the whole hour, plus a run begun in its last second) and at most 14 400 000 (4 copies busy the whole hour, $45.83 a month)."
  }
}

variable "breaker_dws_invocations_per_5min" {
  description = "Trip the DWS pipeline when it runs more than this many times in each of 3 consecutive 5-minute periods. The daily rule runs it once a day, and the backfill about once a minute at most (a window, then the pause; a LeaseBusy retry every 2 minutes; Lambda's own errors after a minute), so a legitimate 5 minutes holds a handful. 60 (one every 5 s) is a loop, which would also be asking DWS far faster than the one request a second its politeness allows."
  type        = number
  default     = 60

  validation {
    condition     = var.breaker_dws_invocations_per_5min >= 30 && var.breaker_dws_invocations_per_5min <= 600
    error_message = "breaker_dws_invocations_per_5min must be 30-600."
  }
}

# --- CloudFront flat-rate plan (flat_rate_plan.tf) -----------------------------

variable "cloudfront_flat_rate_plan" {
  description = "CloudFront's flat-rate pricing plan for the distribution: \"none\" (pay as you go, the default) or \"PRO\" ($15 a month, no overage charges: the distribution, its WAF web ACL and the Route 53 zone in one price). With PRO, Terraform creates the subscription with approval_mode MANUAL, so nothing is billed until the operator approves it in the CloudFront console (docs/hosting.md § Cost controls). Needs site_enabled."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "PRO"], var.cloudfront_flat_rate_plan)
    error_message = "cloudfront_flat_rate_plan is \"none\" or \"PRO\". Business ($200) would be needed only for custom cache, origin-request or response-header policies, which this stack doesn't use."
  }
  validation {
    condition     = var.cloudfront_flat_rate_plan == "none" || var.site_enabled
    error_message = "cloudfront_flat_rate_plan needs site_enabled: the plan covers the distribution."
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

# --- Site (site.tf, edge_functions.tf, waf.tf, flat_rate_plan.tf) -----------

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
  description = "Reserved concurrency for the API, which also caps it. null (the default) reserves none: a new account's limit can be 10, all of which must stay unreserved. Required (5 is plenty) once the account's limit is raised and lambda_account_concurrency_limit says so: the plan refuses a raised limit with no cap. The limit must cover every reservation plus Lambda's 100 unreserved: API reserved + DWS reserved (none) + the spend breaker's 1 + 100, so 106 at the least with 5."
  type        = number
  default     = null

  validation {
    condition     = var.api_reserved_concurrency == null ? true : (var.api_reserved_concurrency >= 1 && var.api_reserved_concurrency <= 50)
    error_message = "null, or between 1 and 50."
  }

  # Lambda keeps 100 of the account's concurrency unreserved, for every
  # function without a reservation, the DWS pipeline among them; an apply that
  # reserves into it fails. The spend breaker reserves 1 more once the limit
  # is raised (breaker.tf). Checked here, at plan, against the limit the
  # operator read and set below.
  validation {
    condition     = var.api_reserved_concurrency == null ? true : var.lambda_account_concurrency_limit - var.api_reserved_concurrency - 1 >= 100
    error_message = "api_reserved_concurrency, with the spend breaker's 1 (breaker.tf), leaves the account fewer than the 100 unreserved executions Lambda keeps for the other functions (the DWS pipeline). Raise the account's Lambda concurrency limit (Service Quotas, \"Concurrent executions\"), set lambda_account_concurrency_limit to the new value (aws lambda get-account-settings), then set api_reserved_concurrency = 5."
  }

  # The other way round: once the account's limit is raised, the API must be
  # capped, or a flood of its public Function URL (which skips the WAF) can run
  # as many copies at once as the new limit allows, each billed.
  validation {
    condition     = !var.auth_enabled || var.lambda_account_concurrency_limit <= 10 || var.api_reserved_concurrency != null
    error_message = "lambda_account_concurrency_limit is raised but the API has no cap: set api_reserved_concurrency = 5 in the same apply, so a flood of its Function URL can't run more than 5 at once."
  }
}

variable "lambda_account_concurrency_limit" {
  description = "The account's Lambda concurrent-executions limit in the workload region, as `aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions` reads it. Only checked against api_reserved_concurrency. 10, a new account's limit, until it is raised."
  type        = number
  default     = 10

  validation {
    condition     = var.lambda_account_concurrency_limit >= 10 && floor(var.lambda_account_concurrency_limit) == var.lambda_account_concurrency_limit
    error_message = "A whole number, at least 10."
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
