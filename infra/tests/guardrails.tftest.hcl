# Plan-only guardrails against mocked providers: no AWS credentials, no state.
# They pin what `terraform validate` can't see: the region rule, the feature
# flags' defaults, the budgets and alert topics, and the gated site's wiring
# (private bucket, signed default behaviour, unsigned sign-in only, the API
# behaviour only with the sign-in (auth.tftest.hcl has the rest), the WAF and the edge function attached).
#
#   bin/check-infra.sh   (fmt + validate + test, as CI runs it)

# --- Mocks: copied into every test file (a test file can't share them) -------
# A mocked aws_iam_policy_document renders a random string, which IAM, SNS and
# S3 policy arguments reject as invalid JSON; any well-formed document does.
# Assertions read a document's statement inputs, never its json.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::000000000000:role/ewr-compliance-deploy"
      name = "ewr-compliance-deploy"
      # The bootstrap's trust as IAM returns it (single values collapsed to
      # strings): templates infra/modules/project-baseline.
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/ewr-compliance:environment:production\"}}}]}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "random" {}

mock_provider "archive" {}

# Known IDs and ARNs, so the wiring can be asserted by equality at plan time.
override_resource {
  target          = aws_acm_certificate.site
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{
      domain_name           = "ewr.example.org"
      resource_record_name  = "_0123abcd.ewr.example.org."
      resource_record_type  = "CNAME"
      resource_record_value = "_4567efab.acm-validations.aws."
    }]
  }
}

override_resource {
  target          = aws_wafv2_web_acl.site
  override_during = plan
  values = {
    arn = "arn:aws:wafv2:us-east-1:000000000000:global/webacl/ewr-compliance-site-acl/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_key_group.signing
  override_during = plan
  values = {
    id = "kg-test"
  }
}

override_resource {
  target          = aws_cloudfront_function.site_request
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-request"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "rhp-site"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.api
  override_during = plan
  values = {
    id = "rhp-api"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    id  = "EDISTTEST"
    arn = "arn:aws:cloudfront::000000000000:distribution/EDISTTEST"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:ewr-compliance-prod-alerts"
  }
}

variables {
  aws_region         = "af-south-1"
  github_repo        = "test-owner/ewr-compliance"
  domain_name        = "ewr.example.org"
  route53_zone_id    = "Z0000000000000000000"
  budget_alert_email = "alerts@mail.ewr-test.net"
  # A public key generated for these tests; its private half was never kept.
  # Public keys aren't secret. Unused while site_enabled is false.
  cloudfront_public_keys = {
    "test" = <<-EOT
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqVimeMBRXL+udlnELOIu
      AZ8mjzqJjY+dLf555KMmNdQxFnyoy78gzpzHNJGQNHlUS6qnKfFQ61I7S/hOTnhi
      QiGBTUTJ5KQ3vBh9Y/hX/7/Qnc/EyJ9PtMTc1Jski8ycMMp0g39xkD6m0/NOkOHk
      n2P1/R5EFC5p/iyfB9Qn+qD95zP5EDCCYhLjrDN7eWIN/1Mvr8Gltpw+8I4Mi8Mq
      y+voRUvpPmNXfHIrWUeX1Z+fIaMkacr4d/AxHh7bwSdJtJBgXCOyBtdUdK3GZlwm
      G8gL6d2X3X8FJRqWZZBmnlPLrwisFN/9yEnRR7+QVS1OUkm31jTs0oI8cUUF+Wwj
      hwIDAQAB
      -----END PUBLIC KEY-----
    EOT
  }
}

# --- Region -------------------------------------------------------------------

run "refuses_a_region_outside_south_africa" {
  command = plan
  variables {
    aws_region = "us-east-1"
  }
  expect_failures = [var.aws_region]
}

run "allows_another_region_only_when_declared" {
  command = plan
  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }
}

run "rejects_reserved_alert_mailbox" {
  command = plan
  variables {
    budget_alert_email = "alerts@example.org"
  }
  expect_failures = [var.budget_alert_email]
}

# --- P1 skeleton: the defaults -----------------------------------------------------

run "skeleton_defaults" {
  command = plan

  assert {
    condition     = var.site_enabled == false && length(aws_s3_bucket.site) == 0 && length(aws_cloudfront_distribution.site) == 0
    error_message = "The site is off by default: P1 applies before the CloudFront key pair exists."
  }
  assert {
    condition     = length(aws_wafv2_web_acl.site) == 0 && length(aws_secretsmanager_secret.signing_key) == 0
    error_message = "No WAF or signing-key secret without the site."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "20" && aws_budgets_budget.monthly[0].time_unit == "MONTHLY"
    error_message = "The monthly budget exists by default, at $20."
  }
  assert {
    condition     = length(aws_budgets_budget.daily) == 1 && aws_budgets_budget.daily[0].limit_amount == "2"
    error_message = "The daily budget is derived: ceil(20 x 2.25 / 30) = 2."
  }
  assert {
    condition = alltrue([for n in aws_budgets_budget.monthly[0].notification :
    n.subscriber_sns_topic_arns == toset([aws_sns_topic.alerts_us_east_1.arn])])
    error_message = "Every budget notification goes to the us-east-1 topic."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly[0].notification) == 3
    error_message = "The monthly budget has FORECASTED 100%, ACTUAL 80% and ACTUAL 100%."
  }
  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0
    error_message = "Cost anomaly detection is off until the operator turns it on after the first apply."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == var.budget_alert_email && aws_sns_topic_subscription.alerts_us_east_1_email.endpoint == var.budget_alert_email
    error_message = "Both alert topics mail the operator."
  }
  assert {
    condition     = length(aws_iam_policy.github_deploy) == 0 && length(aws_iam_role_policy_attachment.github_deploy) == 0
    error_message = "With no Lambdas, the deploy role gets no policy from this root at all."
  }
}

run "budgets_off_until_billing_access" {
  command = plan
  variables {
    budget_monthly_usd = 0
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0 && length(aws_budgets_budget.daily) == 0
    error_message = "budget_monthly_usd = 0 skips both budgets."
  }
}

# --- P2: the gated site -------------------------------------------------------------

run "site_needs_a_public_key" {
  command = plan
  variables {
    site_enabled           = true
    cloudfront_public_keys = {}
  }
  expect_failures = [var.cloudfront_public_keys]
}

run "site_wiring" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.site[0].block_public_acls &&
      aws_s3_bucket_public_access_block.site[0].block_public_policy &&
      aws_s3_bucket_public_access_block.site[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.site[0].restrict_public_buckets
    )
    error_message = "The site bucket is private: every public-access block on."
  }
  assert {
    condition     = aws_s3_bucket.site[0].bucket == "ewr-compliance-site-000000000000"
    error_message = "The bucket is named for the project and account."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.site_bucket[0].statement :
      s.effect == "Deny" || (
        one(s.principals).type == "Service" &&
        one(one(s.principals).identifiers) == "cloudfront.amazonaws.com" &&
        one(s.condition).variable == "AWS:SourceArn" &&
        one(one(s.condition).values) == aws_cloudfront_distribution.site[0].arn
      )
    ])
    error_message = "Only this distribution may read the bucket."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.site_bucket[0].statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject", "s3:ListBucket"])
    error_message = "CloudFront may only get and list: never write."
  }
  assert {
    condition     = aws_cloudfront_distribution.site[0].price_class == "PriceClass_All"
    error_message = "PriceClass_All: the only class with South African edges."
  }
  assert {
    condition     = aws_cloudfront_distribution.site[0].web_acl_id == aws_wafv2_web_acl.site[0].arn
    error_message = "The WAF is on the distribution."
  }
  assert {
    condition     = aws_cloudfront_distribution.site[0].aliases == toset(["ewr.example.org"])
    error_message = "The distribution answers for domain_name only."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site[0].default_cache_behavior).trusted_key_groups[0] == "kg-test" && length(one(aws_cloudfront_distribution.site[0].default_cache_behavior).trusted_key_groups) == 1
    error_message = "The default behaviour serves only requests signed by the key group."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site[0].default_cache_behavior).target_origin_id == "s3-site"
    error_message = "The default behaviour reads the site bucket."
  }
  assert {
    condition = one([for f in one(aws_cloudfront_distribution.site[0].default_cache_behavior).function_association :
    f if f.event_type == "viewer-request"]).function_arn == aws_cloudfront_function.site_request[0].arn
    error_message = "The edge function runs on every default-behaviour request."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site[0].default_cache_behavior).response_headers_policy_id == "rhp-site"
    error_message = "The site's headers policy is on the default behaviour."
  }
  assert {
    condition     = [for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b.path_pattern] == ["/signin/*"]
    error_message = "Without auth_enabled, /signin/* is the only other behaviour."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
    try(length(b.trusted_key_groups), 0) == 0 && b.target_origin_id == "s3-site" && b.allowed_methods == toset(["GET", "HEAD"]) if b.path_pattern == "/signin/*"])
    error_message = "/signin/* is unsigned, read-only, from the site bucket."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.site[0].origin) == 1 && length(random_password.api_origin_secret) == 0
    error_message = "No API origin (or its secret) until auth_enabled (P3)."
  }
  assert {
    condition = alltrue([for e in aws_cloudfront_distribution.site[0].custom_error_response :
    e.error_code == 403 && e.response_page_path == "/signin/index.html" && e.error_caching_min_ttl == 0])
    error_message = "CloudFront's unsigned 403 shows the sign-in page, uncached."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site[0].viewer_certificate).minimum_protocol_version == "TLSv1.2_2021"
    error_message = "TLS 1.2 or later."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site[0].default_cache_behavior).viewer_protocol_policy == "redirect-to-https"
    error_message = "HTTP is redirected to HTTPS."
  }
  assert {
    condition     = aws_cloudfront_function.site_request[0].runtime == "cloudfront-js-2.0" && aws_cloudfront_function.site_request[0].publish
    error_message = "The edge function is published, on runtime 2.0."
  }
  assert {
    condition     = length(aws_cloudfront_function.site_request[0].code) < 10240
    error_message = "CloudFront Functions' code limit is 10 KB."
  }
  assert {
    condition     = aws_secretsmanager_secret.signing_key[0].name == "ewr-compliance/cloudfront-signing-key"
    error_message = "The signing-key secret exists, named for the project."
  }
  assert {
    condition     = length(aws_cloudfront_key_group.signing[0].items) == 1
    error_message = "The key group trusts each public key given."
  }
  assert {
    condition     = aws_acm_certificate.site[0].domain_name == "ewr.example.org" && aws_acm_certificate.site[0].validation_method == "DNS"
    error_message = "The certificate is for domain_name, DNS-validated."
  }
  assert {
    condition     = aws_route53_record.site_a[0].zone_id == "Z0000000000000000000" && aws_route53_record.site_aaaa[0].zone_id == "Z0000000000000000000"
    error_message = "The alias records go in the delegated zone."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_5xx[0].alarm_actions == toset([aws_sns_topic.alerts_us_east_1.arn])
    error_message = "The CloudFront alarms page through the us-east-1 topic."
  }
}

# --- WAF ---------------------------------------------------------------------------

run "waf_rules" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition     = aws_wafv2_web_acl.site[0].scope == "CLOUDFRONT"
    error_message = "A CloudFront ACL."
  }
  assert {
    condition     = [for r in aws_wafv2_web_acl.site[0].rule : r.name] == ["RateLimitAuthPerIP", "RateLimitSitePerIP"]
    error_message = "Two rate rules, auth first."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.site[0].rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].limit == 100
    error_message = "Sign-in is limited to 100 per IP per 5 minutes by default."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.site[0].rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/auth/"
    error_message = "The auth rule matches /api/auth/."
  }
  assert {
    condition     = alltrue([for r in aws_wafv2_web_acl.site[0].rule : length(r.action[0].block) == 1])
    error_message = "Both rules block."
  }
  assert {
    condition = alltrue([for r in aws_wafv2_web_acl.site[0].rule :
      r.action[0].block[0].custom_response[0].response_code == 429 &&
    r.action[0].block[0].custom_response[0].custom_response_body_key == "rate_limited"])
    error_message = "A block answers 429 JSON, never 403, which the distribution would swap for the sign-in page."
  }
  assert {
    condition     = one([for b in aws_wafv2_web_acl.site[0].custom_response_body : b.content_type if b.key == "rate_limited"]) == "APPLICATION_JSON"
    error_message = "The 429's body is JSON."
  }
}

run "auth_limit_cannot_exceed_site_limit" {
  command = plan
  variables {
    waf_auth_rate_limit_per_ip = 3000
  }
  expect_failures = [var.waf_auth_rate_limit_per_ip]
}
