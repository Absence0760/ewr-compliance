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
  description = "Names of the Lambda functions CI may update the code of, through the bootstrap deploy role. Empty until P3/P4 add them, and then the deploy policy isn't created at all. The role never gets S3 write: the data goes up only from the workstation (tools/deploy.sh)."
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

variable "api_origin_host" {
  description = "Hostname of the API Lambda's Function URL (<url-id>.lambda-url.<region>.on.aws). Empty (the default) leaves /api/* off the distribution: P3 sets it. Requests to /api/* then reach the default behaviour, signed and served from S3."
  type        = string
  default     = ""

  validation {
    condition     = var.api_origin_host == "" || can(regex("^[a-z0-9]+\\.lambda-url\\.[a-z0-9-]+\\.on\\.aws$", var.api_origin_host))
    error_message = "api_origin_host is empty, or a Lambda Function URL's hostname (<url-id>.lambda-url.<region>.on.aws), with no scheme or path."
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
