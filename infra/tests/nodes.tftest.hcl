# Plan-only tests of the admin node store (nodes.tf, the API's NodeStore grant
# and NODES_BUCKET in auth.tf, the /nodes-data/* behaviour in site.tf) against
# the same mocked providers as guardrails.tftest.hcl. Pinned here:
# nodes_enabled off creates nothing; it needs the API; the bucket is private,
# versioned, and keeps replaced versions a year; CloudFront reads
# serve/nodes-data/* only, for this distribution, signed; and the API may get
# and put serve/nodes-data/* and list that prefix, and never delete.
#
#   bin/check-infra.sh -filter=tests/nodes.tftest.hcl

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


override_resource {
  target          = aws_lambda_function_url.api
  override_during = plan
  values = {
    function_url = "https://abc123def.lambda-url.af-south-1.on.aws/"
  }
}

override_resource {
  target          = aws_dynamodb_table.users
  override_during = plan
  values = {
    arn = "arn:aws:dynamodb:af-south-1:000000000000:table/ewr-compliance-users"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.auth_runtime
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/auth-runtime-AbCdEf"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.signing_key
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/cloudfront-signing-key-AbCdEf"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.api
  override_during = plan
  values = {
    arn = "arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-api"
  }
}

override_resource {
  target          = aws_sesv2_configuration_set.auth
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:configuration-set/ewr-compliance"
  }
}

override_resource {
  target          = aws_sesv2_email_identity.domain
  override_during = plan
  values = {
    dkim_signing_attributes = {
      tokens                  = ["tok1", "tok2", "tok3"]
      next_signing_key_length = "RSA_2048_BIT"
    }
  }
}

override_resource {
  target          = aws_cloudfront_public_key.signing
  override_during = plan
  values = {
    id = "K2JCJMDEHXQW5F"
  }
}

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.site
  override_during = plan
  values = {
    id = "oac-test"
  }
}

override_resource {
  target          = aws_s3_bucket.nodes
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::ewr-compliance-nodes-000000000000"
    bucket                      = "ewr-compliance-nodes-000000000000"
    bucket_regional_domain_name = "ewr-compliance-nodes-000000000000.s3.af-south-1.amazonaws.com"
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


run "nodes_off_creates_nothing" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition = (
      length(aws_s3_bucket.nodes) + length(aws_s3_bucket_public_access_block.nodes) + length(aws_s3_bucket_versioning.nodes) +
      length(aws_s3_bucket_lifecycle_configuration.nodes) + length(aws_s3_bucket_policy.nodes) + length(data.aws_iam_policy_document.nodes_bucket)
    ) == 0 && output.nodes_bucket == null
    error_message = "nodes_enabled is off by default: no store bucket, no bucket policy, no output."
  }
  assert {
    condition = (
      length([for o in aws_cloudfront_distribution.site[0].origin : o if o.origin_id == "s3-nodes"]) == 0 &&
      length([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b if b.path_pattern == "/nodes-data/*"]) == 0
    )
    error_message = "Without the store, the distribution has no /nodes-data/* behaviour: /nodes-data/ falls to the site bucket and is a 404, which the app reads as no overlays."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.api[0].statement : s if startswith(s.sid, "NodeStore")]) == 0
    error_message = "Without the store, the API has no grant on it."
  }
  assert {
    condition     = !contains(keys(one(aws_lambda_function.api[0].environment).variables), "NODES_BUCKET")
    error_message = "Without the store, the API has no NODES_BUCKET."
  }
}

run "nodes_need_the_api" {
  command = plan
  variables {
    site_enabled  = true
    nodes_enabled = true
  }
  expect_failures = [var.nodes_enabled]
}

run "nodes_need_the_site" {
  command = plan
  variables {
    nodes_enabled = true
  }
  expect_failures = [var.nodes_enabled]
}

run "store_is_private_and_keeps_a_year" {
  command = plan
  variables {
    site_enabled  = true
    auth_enabled  = true
    nodes_enabled = true
  }

  assert {
    condition     = aws_s3_bucket.nodes[0].bucket == "ewr-compliance-nodes-000000000000" && output.nodes_bucket == "ewr-compliance-nodes-000000000000"
    error_message = "The bucket is ewr-compliance-nodes-<account>, and the output names it."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.nodes[0].block_public_acls && aws_s3_bucket_public_access_block.nodes[0].block_public_policy &&
      aws_s3_bucket_public_access_block.nodes[0].ignore_public_acls && aws_s3_bucket_public_access_block.nodes[0].restrict_public_buckets
    )
    error_message = "Public access is fully blocked: the store is read only through CloudFront, signed."
  }
  assert {
    condition     = one(aws_s3_bucket_ownership_controls.nodes[0].rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs are off."
  }
  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.nodes[0].rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "SSE-S3."
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.nodes[0].versioning_configuration).status == "Enabled"
    error_message = "Versioned: an admin's wrong upload or delete can be undone by restoring the previous version."
  }
  assert {
    condition = (
      one(one(aws_s3_bucket_lifecycle_configuration.nodes[0].rule).noncurrent_version_expiration).noncurrent_days == 365 &&
      one(one(aws_s3_bucket_lifecycle_configuration.nodes[0].rule).expiration).expired_object_delete_marker == true &&
      one(one(aws_s3_bucket_lifecycle_configuration.nodes[0].rule).abort_incomplete_multipart_upload).days_after_initiation == 1 &&
      one(aws_s3_bucket_lifecycle_configuration.nodes[0].rule).status == "Enabled"
    )
    error_message = "Replaced versions kept 365 days (not 30: nothing rebuilds an admin's upload), expired delete markers removed, incomplete multipart uploads aborted after a day."
  }
}

run "cloudfront_reads_serve_only_signed" {
  command = plan
  variables {
    site_enabled  = true
    auth_enabled  = true
    nodes_enabled = true
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b.path_pattern] == ["/signin/*", "/nodes-data/*", "/api/*"]
    error_message = "/nodes-data/* comes before /api/*."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
      b.target_origin_id == "s3-nodes" && one(b.trusted_key_groups) == "kg-test" && b.response_headers_policy_id == null &&
      { for f in b.function_association : f.event_type => f.function_arn } == {
        "viewer-request"  = "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-request"
        "viewer-response" = "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-response"
      } &&
      toset(b.allowed_methods) == toset(["GET", "HEAD", "OPTIONS"]) &&
      b.cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6"
    if b.path_pattern == "/nodes-data/*"])
    error_message = "/nodes-data/* is signed exactly as the default behaviour: the same key group, functions and headers, read-only, CachingOptimized."
  }
  assert {
    condition = length([for o in aws_cloudfront_distribution.site[0].origin : o if
      o.origin_id == "s3-nodes" && o.origin_path == "/serve" &&
      o.domain_name == "ewr-compliance-nodes-000000000000.s3.af-south-1.amazonaws.com" &&
    o.origin_access_control_id == "oac-test"]) == 1
    error_message = "One s3-nodes origin, the store's bucket through the site's OAC, with origin path /serve: /nodes-data/index.json is the key serve/nodes-data/index.json."
  }
  assert {
    condition     = one([for s in data.aws_iam_policy_document.nodes_bucket[0].statement : s.resources if s.sid == "AllowCloudFrontReadServe"]) == toset(["arn:aws:s3:::ewr-compliance-nodes-000000000000/serve/nodes-data/*"])
    error_message = "CloudFront reads serve/nodes-data/* only."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.nodes_bucket[0].statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject", "s3:ListBucket"])
    error_message = "CloudFront may get and list (a missing file is a 404, not the sign-in page's 403), nothing more."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.nodes_bucket[0].statement :
      toset(one(s.principals).identifiers) == toset(["cloudfront.amazonaws.com"]) &&
      one(s.condition).variable == "AWS:SourceArn" && toset(one(s.condition).values) == toset(["arn:aws:cloudfront::000000000000:distribution/EDISTTEST"])
    if s.effect != "Deny"])
    error_message = "Every allow is for CloudFront, and only this distribution."
  }
  assert {
    condition = one([for s in data.aws_iam_policy_document.nodes_bucket[0].statement :
      one(s.condition).variable == "aws:SecureTransport" && toset(one(s.condition).values) == toset(["false"]) && toset(s.actions) == toset(["s3:*"])
    if s.sid == "DenyInsecureTransport" && s.effect == "Deny"])
    error_message = "Plain HTTP to the bucket is denied."
  }
}

run "api_may_get_and_put_the_served_files_only" {
  command = plan
  variables {
    site_enabled  = true
    auth_enabled  = true
    nodes_enabled = true
  }

  assert {
    condition = (
      toset(one([for s in data.aws_iam_policy_document.api[0].statement : s.actions if s.sid == "NodeStore"])) == toset(["s3:GetObject", "s3:PutObject"]) &&
      toset(one([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid == "NodeStore"])) == toset(["arn:aws:s3:::ewr-compliance-nodes-000000000000/serve/nodes-data/*"]) &&
      length(one([for s in data.aws_iam_policy_document.api[0].statement : s.condition if s.sid == "NodeStore"])) == 0
    )
    error_message = "NodeStore: GetObject and PutObject on serve/nodes-data/* only."
  }
  assert {
    condition = (
      toset(one([for s in data.aws_iam_policy_document.api[0].statement : s.actions if s.sid == "NodeStoreList"])) == toset(["s3:ListBucket"]) &&
      toset(one([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid == "NodeStoreList"])) == toset(["arn:aws:s3:::ewr-compliance-nodes-000000000000"]) &&
      length(one([for s in data.aws_iam_policy_document.api[0].statement : s.condition if s.sid == "NodeStoreList"])) == 0
    )
    error_message = "NodeStoreList: ListBucket on the store, with no s3:prefix condition (a missing file must be a 404 to the API, not a 403)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.api[0].statement : s.actions if startswith(s.sid, "NodeStore")])) == toset(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]) &&
      length([for s in data.aws_iam_policy_document.api[0].statement : s if startswith(s.sid, "NodeStore")]) == 2
    )
    error_message = "Nothing else on the store: no DeleteObject (a delete is a tombstone in the WMA's file), no wildcard action."
  }
  assert {
    condition     = length([for a in flatten([for s in data.aws_iam_policy_document.api[0].statement : s.actions]) : a if startswith(a, "s3:")]) == 3
    error_message = "The node store is the API's only S3 grant: the site's files stay CloudFront's."
  }
  assert {
    condition     = one(aws_lambda_function.api[0].environment).variables.NODES_BUCKET == "ewr-compliance-nodes-000000000000"
    error_message = "The API is told the store's bucket by name (a public value)."
  }
}
