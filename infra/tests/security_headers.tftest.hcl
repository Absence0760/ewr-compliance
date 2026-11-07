# The response headers, pinned. These replace static/_headers and
# src/headers.test.ts from the Cloudflare design: the same three headers on
# every file, now from a CloudFront response-headers policy, plus HSTS.
# Cache-Control moved to the objects themselves (tools/deploy.sh sets it as it
# uploads), so the policy must not set it: a policy value would override the
# per-file one. docs/hosting.md § Headers.

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

run "site_headers" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).content_security_policy).content_security_policy == "frame-ancestors 'none'"
    error_message = "The header policy adds frame-ancestors 'none' only: the page's own policy is SvelteKit's meta tag, and a second policy can only tighten it."
  }
  assert {
    condition     = length(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).content_type_options) == 1
    error_message = "X-Content-Type-Options: nosniff on every file."
  }
  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).referrer_policy).referrer_policy == "strict-origin-when-cross-origin"
    error_message = "Referrer-Policy: strict-origin-when-cross-origin, as on Pages."
  }
  assert {
    condition = (
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).strict_transport_security).access_control_max_age_sec == 63072000 &&
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).strict_transport_security).include_subdomains &&
      !one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).strict_transport_security).preload
    )
    error_message = "HSTS for two years, subdomains included, no preload (the parent domain isn't this project's to preload)."
  }
  assert {
    condition = alltrue([
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).content_security_policy).override,
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).content_type_options).override,
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).referrer_policy).override,
      one(one(aws_cloudfront_response_headers_policy.site[0].security_headers_config).strict_transport_security).override,
    ])
    error_message = "Every header overrides whatever the origin sends."
  }
  assert {
    condition     = length(aws_cloudfront_response_headers_policy.site[0].custom_headers_config) == 0
    error_message = "No custom headers: in particular no Cache-Control, which is per object (tools/deploy.sh)."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
    b.response_headers_policy_id == "rhp-site" if b.target_origin_id == "s3-site"])
    error_message = "Every behaviour on the bucket carries the site's headers."
  }
}

run "api_headers" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.api[0].security_headers_config).content_security_policy).content_security_policy == "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    error_message = "API JSON: nothing may load, run or frame."
  }
  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.api[0].security_headers_config).referrer_policy).referrer_policy == "no-referrer"
    error_message = "The API sends no referrer."
  }
}
