# ----------------------------------------------------------------------------
# CloudFront flat-rate pricing plan (decision Q8, docs/hosting.md § Cost
# controls). Off by default: cloudfront_flat_rate_plan = "none".
#
# With "PRO" ($15 a month, no overage charges whatever the traffic), this
# subscribes the distribution, its WAF web ACL and the site's Route 53 zone
# (the bootstrap's delegated zone, in this account, covering domain_name) to
# the plan, so the edge's request, data and WAF charges and the zone's fee
# and queries become one fixed price. Without it they are pay as you go, and
# nothing caps them (the CloudFront request alarm mails; docs/hosting.md §
# Cost controls has the arithmetic).
#
# approval_mode = "MANUAL": the subscription is created PENDING_APPROVAL and
# billed nothing until the operator approves it in the CloudFront console
# (the distribution's Manage plan). Destroying it while pending deletes it at
# once; once active, a cancellation takes effect at the end of the billing
# period, and until then the web ACL can't be removed and the distribution
# can't be deleted.
#
# Never `terraform import` an existing subscription: hashicorp/
# terraform-provider-aws#50494. If one was made in the console, cancel it
# there, or leave this at "none".
#
# What the plan needs of the distribution, as this stack sets it up: only
# AWS's managed cache and origin-request policies (CachingOptimized,
# CachingDisabled, AllViewerExceptHostHeader; custom ones are Business), no
# custom response-headers policy (the headers are the site_response function,
# edge_functions.tf), a WAF web ACL with custom rules only (no rule groups;
# Pro allows custom WAF responses, which the 429s are), OAC rather than OAI,
# cache policies rather than forwarded_values, 4 behaviours of Pro's 10, and
# a function and web ACL used by this distribution alone. The questions the
# plan's documentation leaves open for this setup are the operator's to
# check before approving: docs/hosting.md § Cost controls.
#
# Needs hashicorp/aws >= 6.69 (main.tf). Pricing Plan Manager is a global
# service, called through us-east-1 as CloudFront's other global pieces are.
# ----------------------------------------------------------------------------

resource "aws_pricingplanmanager_subscription" "cloudfront" {
  count    = var.cloudfront_flat_rate_plan == "none" ? 0 : 1
  provider = aws.us_east_1

  plan_family   = "CloudFront"
  plan_tier     = var.cloudfront_flat_rate_plan
  approval_mode = "MANUAL"

  resource_arns = [
    aws_cloudfront_distribution.site[0].arn,
    aws_wafv2_web_acl.site[0].arn,
    "arn:aws:route53:::hostedzone/${var.route53_zone_id}",
  ]
}
