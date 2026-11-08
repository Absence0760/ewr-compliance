# The response headers, pinned. These replace static/_headers and
# src/headers.test.ts from the Cloudflare design: the same three headers on
# every file, plus HSTS, now from the site_response CloudFront Function
# (edge_functions.tf; decision Q7), which replaced the two response-headers
# policies so a flat-rate plan can be taken. Its code runs in
# tools/edge-functions.test.ts; here its text and its wiring are pinned. No
# response-headers policy is left (Free and Pro allow only AWS's managed ones).
# Cache-Control is per object (tools/deploy.sh sets it as it uploads), so the
# function must not set it. The /api/* and /dws/* behaviours' association is
# pinned in auth.tftest.hcl, dws.tftest.hcl and cost.tftest.hcl.
# docs/hosting.md § Headers.

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
  target          = aws_cloudfront_function.site_response
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-response"
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

run "headers_function" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition     = aws_cloudfront_function.site_response[0].runtime == "cloudfront-js-2.0" && aws_cloudfront_function.site_response[0].publish
    error_message = "The headers function is cloudfront-js-2.0, published (an unpublished function is only a DEVELOPMENT stage, never served)."
  }
  assert {
    condition = alltrue([for h in [
      "'strict-transport-security': HSTS",
      "var HSTS = 'max-age=63072000; includeSubDomains';",
      "'x-content-type-options': 'nosniff'",
      "'content-security-policy': \"frame-ancestors 'none'\"",
      "'referrer-policy': 'strict-origin-when-cross-origin'",
      "'content-security-policy': \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"",
      "'referrer-policy': 'no-referrer'",
      "indexOf('/api/') === 0 ? API : SITE",
    ] : strcontains(aws_cloudfront_function.site_response[0].code, h)])
    error_message = "The site's four headers (frame-ancestors 'none', nosniff, strict-origin-when-cross-origin, HSTS two years with subdomains and no preload) and the API's (default-src 'none' ..., no-referrer) are in the function's code, the API's under /api/ only."
  }
  assert {
    condition     = !strcontains(lower(aws_cloudfront_function.site_response[0].code), "cache-control") && !strcontains(aws_cloudfront_function.site_response[0].code, "preload")
    error_message = "No Cache-Control (per object, tools/deploy.sh) and no HSTS preload (the parent domain isn't this project's to preload)."
  }
  assert {
    condition     = length(aws_cloudfront_function.site_response[0].code) < 10240 && length(aws_cloudfront_function.site_request[0].code) < 10240
    error_message = "A CloudFront Function's code is at most 10 KB."
  }
  assert {
    condition = alltrue([for h in [
      "'strict-transport-security': 'max-age=63072000; includeSubDomains'",
      "'content-security-policy': \"frame-ancestors 'none'\"",
      "for (var name in SECURITY) headers[name]",
    ] : strcontains(aws_cloudfront_function.site_request[0].code, h)])
    error_message = "The viewer-request function's own answers (302, 401, 301, 404) carry the site's headers: a viewer-response function never runs on them."
  }
}

run "every_site_behaviour_sets_the_headers" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition = alltrue([for b in concat(aws_cloudfront_distribution.site[0].default_cache_behavior, aws_cloudfront_distribution.site[0].ordered_cache_behavior) :
      b.response_headers_policy_id == null &&
      one([for f in b.function_association : f.function_arn if f.event_type == "viewer-response"]) == "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-response" &&
      one([for f in b.function_association : f.function_arn if f.event_type == "viewer-request"]) == "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-request"
    ])
    error_message = "The default and /signin/* behaviours run site_request on the request and site_response on the response, and carry no response-headers policy."
  }
}
