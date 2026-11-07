# Plan-only tests of the sign-in (auth.tf) against the same mocked providers
# as guardrails.tftest.hcl. Pinned here: auth_enabled off creates nothing;
# the table's PITR, TTL on `ttl`, deletion protection and string keys; the
# API role's grants, each on its one resource (auth-kit's action list on the
# table, SES only as no-reply@, only its two secrets, only its log group);
# no key in the Lambda's environment; /api/* never cached, behind the origin
# secret; the deploy role may update the API's code and nothing more; and the
# alarms.
#
#   bin/check-infra.sh -filter=tests/auth.tftest.hcl

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

# --- Off by default ------------------------------------------------------------

run "auth_off_creates_nothing" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition = (
      length(aws_dynamodb_table.users) == 0 && length(aws_lambda_function.api) == 0 &&
      length(aws_lambda_function_url.api) == 0 && length(aws_secretsmanager_secret.auth_runtime) == 0 &&
      length(random_password.auth_code_key) == 0 && length(random_password.auth_session_key) == 0 &&
      length(aws_sesv2_email_identity.domain) == 0 && length(aws_route53_record.ses_dkim) == 0 &&
      length(aws_cloudwatch_metric_alarm.auth_locked) == 0 && length(aws_iam_role.api) == 0
    )
    error_message = "auth_enabled is off by default, and then no sign-in resource exists."
  }
  assert {
    condition     = length(aws_iam_policy.github_deploy) == 0
    error_message = "Without the API (or other Lambdas), the deploy role gets no policy."
  }
}

run "auth_needs_the_site" {
  command = plan
  variables {
    auth_enabled = true
  }
  expect_failures = [var.auth_enabled]
}

# --- On ----------------------------------------------------------------------------

run "user_table" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition     = aws_dynamodb_table.users[0].hash_key == "pk" && aws_dynamodb_table.users[0].range_key == "sk"
    error_message = "auth-kit's keys: pk and sk."
  }
  assert {
    condition     = alltrue([for a in aws_dynamodb_table.users[0].attribute : a.type == "S"]) && length(aws_dynamodb_table.users[0].attribute) == 2
    error_message = "Two string key attributes, nothing else declared."
  }
  assert {
    condition     = one(aws_dynamodb_table.users[0].ttl).attribute_name == "ttl" && one(aws_dynamodb_table.users[0].ttl).enabled
    error_message = "TTL on `ttl`: codes, throttles, revocations and the 24-month audit rows expire."
  }
  assert {
    condition     = one(aws_dynamodb_table.users[0].point_in_time_recovery).enabled
    error_message = "PITR: deleted items restorable for 35 days (the privacy notice's backup period)."
  }
  assert {
    condition     = aws_dynamodb_table.users[0].deletion_protection_enabled
    error_message = "Deletion protection on the user table."
  }
  assert {
    condition     = aws_dynamodb_table.users[0].billing_mode == "PAY_PER_REQUEST"
    error_message = "On-demand."
  }
}

run "api_iam_is_scoped" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition = toset(one([for s in data.aws_iam_policy_document.api[0].statement : s.actions if s.sid == "UserTable"])) == toset([
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
    ])
    error_message = "The table grant is exactly auth-kit's DYNAMODB_IAM_ACTIONS: no Scan, no BatchWriteItem, no table management."
  }
  assert {
    condition     = one([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid == "UserTable"]) == toset(["arn:aws:dynamodb:af-south-1:000000000000:table/ewr-compliance-users"])
    error_message = "On this table only, no index or wildcard."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.api[0].statement :
    one(s.condition).variable == "ses:FromAddress" && toset(one(s.condition).values) == toset(["no-reply@ewr.example.org"]) && toset(s.actions) == toset(["ses:SendEmail"]) if s.sid == "SendAsNoReplyOnly"])
    error_message = "SES: SendEmail only, and only as no-reply@<domain>."
  }
  assert {
    condition = one([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid == "ReadOwnSecrets"]) == toset([
      "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/auth-runtime-AbCdEf",
      "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/cloudfront-signing-key-AbCdEf",
    ])
    error_message = "GetSecretValue on its runtime secret and the signing key, by ARN."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.api[0].statement : s.actions])) == toset([
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
      "ses:SendEmail", "secretsmanager:GetSecretValue", "logs:CreateLogStream", "logs:PutLogEvents",
    ])
    error_message = "Nothing else: no S3 (the site's files are CloudFront's), no wildcard action."
  }
  assert {
    condition = alltrue([for r in flatten([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid != "SendAsNoReplyOnly"]) :
    !strcontains(r, "*") || r == "arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-api:*"])
    error_message = "No wildcard resource but the log group's own streams (SES's identity/* is pinned by FromAddress)."
  }
  assert {
    condition = one([for s in data.aws_iam_policy_document.api[0].statement : s.resources if s.sid == "SendAsNoReplyOnly"]) == toset([
      "arn:aws:ses:af-south-1:000000000000:identity/*",
      "arn:aws:ses:af-south-1:000000000000:configuration-set/ewr-compliance",
    ])
    error_message = "SES: identities in this account and region, and this configuration set; never \"*\"."
  }
  assert {
    condition     = aws_iam_role.api[0].name == "ewr-compliance-api-lambda" && length(aws_iam_role_policy.api) == 1
    error_message = "One inline policy on the API's own role."
  }
}

run "no_secret_in_the_environment" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition = toset(keys(one(aws_lambda_function.api[0].environment).variables)) == toset([
      "USERS_TABLE", "SITE_DOMAIN", "MAIL_FROM", "SES_CONFIGURATION_SET", "CLOUDFRONT_KEY_PAIR_ID",
      "CLOUDFRONT_PUBLIC_KEY", "RUNTIME_SECRET_ARN", "RUNTIME_SECRET_VERSION", "SIGNING_KEY_SECRET_ARN",
    ])
    error_message = "Names and public values only: GetFunctionConfiguration (which the CI role has) reads the environment in clear. The keys are in the runtime secret."
  }
  assert {
    condition     = one(aws_lambda_function.api[0].environment).variables.CLOUDFRONT_KEY_PAIR_ID == "K2JCJMDEHXQW5F" && one(aws_lambda_function.api[0].environment).variables.SITE_DOMAIN == "ewr.example.org"
    error_message = "The API signs with the only public key, for the site's domain."
  }
  assert {
    condition     = random_password.auth_code_key[0].length >= 32 && random_password.auth_session_key[0].length >= 32
    error_message = "auth-kit's keys are at least 32 characters (MIN_SECRET_LENGTH)."
  }
  assert {
    condition     = aws_secretsmanager_secret_version.auth_runtime[0].secret_string_wo_version == 1
    error_message = "The runtime secret is written write-only (secret_string_wo), never secret_string."
  }
  assert {
    condition     = aws_lambda_function.api[0].runtime == "nodejs24.x" && tolist(aws_lambda_function.api[0].architectures) == tolist(["arm64"])
    error_message = "Node 24 on arm64."
  }
  assert {
    condition     = aws_lambda_function_url.api[0].authorization_type == "NONE" && length(try(aws_lambda_function_url.api[0].cors, [])) == 0
    error_message = "The Function URL is only reached through CloudFront; no CORS."
  }
}

run "api_behaviour" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b.path_pattern] == ["/signin/*", "/api/*"]
    error_message = "With the sign-in, /api/* follows /signin/*."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" && b.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac" &&
      b.target_origin_id == "lambda-api" && try(length(b.trusted_key_groups), 0) == 0 && b.response_headers_policy_id == "rhp-api" &&
      b.viewer_protocol_policy == "https-only"
    if b.path_pattern == "/api/*"])
    error_message = "/api/* is never cached (CachingDisabled), forwards cookies and Origin (AllViewerExceptHostHeader), HTTPS only, with the API's headers."
  }
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.site[0].origin :
      o.domain_name == "abc123def.lambda-url.af-south-1.on.aws" && o.custom_origin_config[0].origin_protocol_policy == "https-only" &&
    one(o.custom_header).name == "X-Origin-Secret" if o.origin_id == "lambda-api"])
    error_message = "The API origin is the Function URL's host, HTTPS only, stamped with the origin secret."
  }
  assert {
    condition     = length(random_password.api_origin_secret) == 1 && random_password.api_origin_secret[0].length >= 32
    error_message = "The origin secret exists with the API, at least 32 characters."
  }
}

run "deploy_role_updates_the_api_code_only" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.resources])) == toset([
      "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-api",
    ])
    error_message = "The deploy role may update the API, by ARN, and nothing else."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.actions])) == toset([
      "lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
    ])
    error_message = "Code only: never its configuration, role or environment."
  }
}

run "ses_and_dns" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition     = aws_sesv2_email_identity.domain[0].email_identity == "ewr.example.org"
    error_message = "SES sends for the site's domain."
  }
  assert {
    condition     = [for r in aws_route53_record.ses_dkim : r.records] == [toset(["tok1.dkim.af-south-1.amazonses.com"]), toset(["tok2.dkim.af-south-1.amazonses.com"]), toset(["tok3.dkim.af-south-1.amazonses.com"])]
    error_message = "Easy DKIM's three CNAMEs point at af-south-1's regional DKIM domain."
  }
  assert {
    condition     = one(aws_sesv2_configuration_set.auth[0].delivery_options).tls_policy == "REQUIRE"
    error_message = "A sign-in code is never sent without TLS."
  }
  assert {
    condition     = aws_route53_record.dmarc[0].records == toset(["v=DMARC1; p=none; adkim=r; aspf=r"])
    error_message = "DMARC starts at p=none."
  }
}

run "alarms" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_locked[0].pattern == "\"auth.locked\"" && aws_cloudwatch_log_metric_filter.auth_locked[0].log_group_name == "/aws/lambda/ewr-compliance-api"
    error_message = "auth.locked is counted from the API's log."
  }
  assert {
    condition = alltrue([for a in [aws_cloudwatch_metric_alarm.api_errors[0], aws_cloudwatch_metric_alarm.ses_bounce_rate[0], aws_cloudwatch_metric_alarm.ses_complaint_rate[0], aws_cloudwatch_metric_alarm.auth_locked[0]] :
    a.alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"])])
    error_message = "The four sign-in alarms page through the regional topic."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_slow[0].pattern == "\"auth.slow\"" && aws_cloudwatch_metric_alarm.auth_slow[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"])
    error_message = "auth.slow (a sign-in step past its timing floor) is counted and alarmed."
  }
}

run "two_keys_need_a_signer" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
    cloudfront_public_keys = {
      "old" = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"
      "new" = "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----"
    }
  }
  expect_failures = [aws_lambda_function.api]
}

run "the_named_key_signs" {
  command = plan
  variables {
    site_enabled           = true
    auth_enabled           = true
    cloudfront_signing_key = "new"
    cloudfront_public_keys = {
      "old" = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"
      "new" = "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----"
    }
  }
  assert {
    condition     = one(aws_lambda_function.api[0].environment).variables.CLOUDFRONT_PUBLIC_KEY == "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----"
    error_message = "cloudfront_signing_key picks the key the API signs with."
  }
}

run "rejects_an_unknown_signer" {
  command = plan
  variables {
    cloudfront_signing_key = "nope"
  }
  expect_failures = [var.cloudfront_signing_key]
}
