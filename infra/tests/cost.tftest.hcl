# Plan-only tests of the spend controls (decisions Q6-Q8, docs/hosting.md §
# Cost controls) against the same mocked providers as guardrails.tftest.hcl:
# the spend breaker (breaker.tf): its single permission on the protected
# functions, its topic's publishers, its wiring, the trip thresholds and
# their bounds, its own reservation; the headers function on every behaviour
# with every feature on, and only AWS's managed cache and origin-request
# policies (what a flat-rate plan below Business allows); and the optional
# flat-rate plan (flat_rate_plan.tf), off by default, MANUAL approval.
#
#   bin/check-infra.sh -filter=tests/cost.tftest.hcl

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
  target          = aws_s3_bucket.dws
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::ewr-compliance-dws-000000000000"
    bucket                      = "ewr-compliance-dws-000000000000"
    bucket_regional_domain_name = "ewr-compliance-dws-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.dws_api_key
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/dws-api-key-AbCdEf"
  }
}

override_resource {
  target          = aws_sqs_queue.dws_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:ewr-compliance-dws-dlq"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.dws
  override_during = plan
  values = {
    arn = "arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-dws"
  }
}

override_resource {
  target          = aws_lambda_function.dws
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.dws_daily
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/ewr-compliance-dws-daily"
  }
}

override_resource {
  target          = aws_iam_role.dws_backfill
  override_during = plan
  values = {
    arn = "arn:aws:iam::000000000000:role/ewr-compliance-dws-backfill"
  }
}

override_resource {
  target          = aws_lambda_function.api
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-api"
  }
}

override_resource {
  target          = aws_sns_topic.breaker
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:ewr-compliance-breaker"
  }
}

override_resource {
  target          = aws_lambda_function.breaker
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-breaker"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.breaker
  override_during = plan
  values = {
    arn = "arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-breaker"
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


# --- The spend breaker ------------------------------------------------------------

run "breaker_only_with_a_function_to_protect" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition = (
      length(aws_lambda_function.breaker) + length(aws_sns_topic.breaker) + length(aws_iam_role.breaker) +
      length(aws_cloudwatch_metric_alarm.breaker_errors) + length(aws_cloudwatch_metric_alarm.breaker_concurrency) +
      length(aws_cloudwatch_metric_alarm.breaker_duration) + length(aws_cloudwatch_metric_alarm.breaker_invocations)
    ) == 0
    error_message = "With no API and no pipeline there is nothing to stop, so no breaker."
  }
}

run "breaker_wiring" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
    dws_enabled  = true
  }

  assert {
    condition = jsondecode(aws_lambda_function.breaker[0].environment[0].variables["PROTECTED"]) == {
      "ewr-compliance-breaker-api-" = "ewr-compliance-api"
      "ewr-compliance-breaker-dws-" = "ewr-compliance-dws"
    }
    error_message = "The breaker maps each trip alarm's prefix to the function it stops: the API and the DWS pipeline."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.breaker[0].statement) == 2 &&
      toset(data.aws_iam_policy_document.breaker[0].statement[0].actions) == toset(["lambda:PutFunctionConcurrency"]) &&
      toset(data.aws_iam_policy_document.breaker[0].statement[0].resources) == toset([
        "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-api",
        "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws",
      ]) &&
      toset(data.aws_iam_policy_document.breaker[0].statement[1].actions) == toset(["logs:CreateLogStream", "logs:PutLogEvents"]) &&
      toset(data.aws_iam_policy_document.breaker[0].statement[1].resources) == toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-breaker:*"])
    )
    error_message = "The breaker's role holds one action on the protected functions, lambda:PutFunctionConcurrency (no DeleteFunctionConcurrency, no invoke, no wildcard), and its own log streams."
  }
  assert {
    condition = (
      toset(one(data.aws_iam_policy_document.breaker_publish[0].statement).actions) == toset(["sns:Publish"]) &&
      toset(one(one(data.aws_iam_policy_document.breaker_publish[0].statement).principals).identifiers) == toset(["cloudwatch.amazonaws.com"]) &&
      toset(one([for c in one(data.aws_iam_policy_document.breaker_publish[0].statement).condition : c.values if c.variable == "aws:SourceArn" && c.test == "ArnLike"])) == toset([
        "arn:aws:cloudwatch:af-south-1:000000000000:alarm:ewr-compliance-breaker-api-*",
        "arn:aws:cloudwatch:af-south-1:000000000000:alarm:ewr-compliance-breaker-dws-*",
      ]) &&
      toset(one([for c in one(data.aws_iam_policy_document.breaker_publish[0].statement).condition : c.values if c.variable == "aws:SourceAccount"])) == toset(["000000000000"])
    )
    error_message = "Only this account's trip alarms (breaker-api-*, breaker-dws-*) may publish to the breaker topic: not breaker-errors, not any other alarm."
  }
  assert {
    condition = (
      aws_sns_topic_subscription.breaker[0].protocol == "lambda" &&
      aws_sns_topic_subscription.breaker[0].endpoint == "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-breaker" &&
      aws_sns_topic_subscription.breaker[0].topic_arn == "arn:aws:sns:af-south-1:000000000000:ewr-compliance-breaker" &&
      aws_lambda_permission.breaker_sns[0].principal == "sns.amazonaws.com" &&
      aws_lambda_permission.breaker_sns[0].source_arn == "arn:aws:sns:af-south-1:000000000000:ewr-compliance-breaker"
    )
    error_message = "The topic invokes the breaker, and only that topic may."
  }
  assert {
    condition = alltrue([for a in concat(values(aws_cloudwatch_metric_alarm.breaker_concurrency), values(aws_cloudwatch_metric_alarm.breaker_duration), values(aws_cloudwatch_metric_alarm.breaker_invocations)) :
      a.alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts", "arn:aws:sns:af-south-1:000000000000:ewr-compliance-breaker"]) &&
      a.namespace == "AWS/Lambda" && a.treat_missing_data == "notBreaching" && startswith(a.alarm_name, "ewr-compliance-breaker-")
    ])
    error_message = "Every trip mails the regional topic and trips the breaker, on the function's own AWS/Lambda metric."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_errors[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      aws_cloudwatch_metric_alarm.breaker_errors[0].dimensions["FunctionName"] == "ewr-compliance-breaker" &&
      aws_cloudwatch_metric_alarm.breaker_errors[0].metric_name == "Errors" && aws_cloudwatch_metric_alarm.breaker_errors[0].threshold == 1
    )
    error_message = "The breaker's own errors mail the operator, and never trip the breaker."
  }
  assert {
    condition     = aws_lambda_function.breaker[0].reserved_concurrent_executions == null || aws_lambda_function.breaker[0].reserved_concurrent_executions == -1
    error_message = "On a new account's limit of 10 the breaker reserves nothing (all 10 must stay unreserved)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_throttled[0].metric_name == "Throttles" &&
      aws_cloudwatch_metric_alarm.breaker_throttled[0].threshold == 1 &&
      aws_cloudwatch_metric_alarm.breaker_throttled[0].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.breaker_throttled[0].period == 300 &&
      aws_cloudwatch_metric_alarm.breaker_throttled[0].dimensions["FunctionName"] == "ewr-compliance-breaker" &&
      aws_cloudwatch_metric_alarm.breaker_throttled[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      !startswith(aws_cloudwatch_metric_alarm.breaker_throttled[0].alarm_name, "ewr-compliance-breaker-api-") &&
      !startswith(aws_cloudwatch_metric_alarm.breaker_throttled[0].alarm_name, "ewr-compliance-breaker-dws-")
    )
    error_message = "A throttled breaker (starved at a limit of 10) mails within 5 minutes, and never publishes to the breaker topic."
  }
  assert {
    condition     = aws_lambda_function.breaker[0].memory_size == 128 && aws_lambda_function.breaker[0].timeout == 10
    error_message = "The breaker is small and short."
  }
}

run "breaker_thresholds" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
    dws_enabled  = true
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].threshold == 4 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].metric_name == "ConcurrentExecutions" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].period == 300 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["api"].dimensions["FunctionName"] == "ewr-compliance-api"
    )
    error_message = "API: 4 or more copies in each of three 5-minute periods running."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_duration["api"].threshold == 3600000 &&
      aws_cloudwatch_metric_alarm.breaker_duration["api"].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.breaker_duration["api"].metric_name == "Duration" &&
      aws_cloudwatch_metric_alarm.breaker_duration["api"].period == 3600 &&
      aws_cloudwatch_metric_alarm.breaker_duration["api"].evaluation_periods == 1
    )
    error_message = "API: more than one copy-hour (3 600 000 ms) in a clock hour."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_invocations["api"].threshold == 3000 &&
      aws_cloudwatch_metric_alarm.breaker_invocations["api"].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.breaker_invocations["api"].period == 300 &&
      aws_cloudwatch_metric_alarm.breaker_invocations["api"].datapoints_to_alarm == 3
    )
    error_message = "API: more than 3 000 calls in each of three 5-minute periods running (10 a second)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_concurrency["dws"].threshold == 3 &&
      aws_cloudwatch_metric_alarm.breaker_duration["dws"].threshold == 5400000 &&
      aws_cloudwatch_metric_alarm.breaker_invocations["dws"].threshold == 60 &&
      aws_cloudwatch_metric_alarm.breaker_duration["dws"].dimensions["FunctionName"] == "ewr-compliance-dws"
    )
    error_message = "DWS pipeline: 3 copies for 15 minutes, 5 400 000 ms an hour, 60 calls per 5 minutes for 15."
  }
  # The backfill's busiest legitimate hour: one copy the whole hour, plus a
  # 900 s run begun in its last second (Duration is dated at a run's start).
  # Its busiest moment: two copies. Its calls: about one a minute.
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_duration["dws"].threshold > 3600000 + aws_lambda_function.dws[0].timeout * 1000 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency["dws"].threshold > 2 &&
      aws_cloudwatch_metric_alarm.breaker_invocations["dws"].threshold > 300 / var.dws_backfill_wait_seconds * 5
    )
    error_message = "No trip of the pipeline's can fire on a legitimate backfill beside the daily run."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.breaker_duration["api"].threshold > aws_lambda_function.api[0].timeout * 1000 * 100
    error_message = "The API's Duration trip is far above a busy hour's calls."
  }
}

run "breaker_protects_the_api_alone_without_the_store" {
  command = plan
  variables {
    site_enabled = true
    auth_enabled = true
  }

  assert {
    condition     = keys(aws_cloudwatch_metric_alarm.breaker_duration) == ["api"] && toset(data.aws_iam_policy_document.breaker[0].statement[0].resources) == toset(["arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-api"])
    error_message = "Without the store, the breaker stops the API only."
  }
  assert {
    condition     = toset(one([for c in one(data.aws_iam_policy_document.breaker_publish[0].statement).condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:cloudwatch:af-south-1:000000000000:alarm:ewr-compliance-breaker-api-*"])
    error_message = "Only the API's trips may publish."
  }
}

run "breaker_reserves_one_once_the_limit_is_raised" {
  command = plan
  variables {
    site_enabled                     = true
    auth_enabled                     = true
    lambda_account_concurrency_limit = 1000
    api_reserved_concurrency         = 5
  }

  assert {
    condition     = aws_lambda_function.breaker[0].reserved_concurrent_executions == 1
    error_message = "With the limit raised, the breaker reserves 1, so the flood it stops can't starve it."
  }
}

run "api_concurrency_trip_above_its_cap_refused" {
  command = plan
  variables {
    site_enabled                     = true
    auth_enabled                     = true
    lambda_account_concurrency_limit = 1000
    api_reserved_concurrency         = 5
    breaker_api_concurrency          = 6
  }
  expect_failures = [var.breaker_api_concurrency]
}

run "dws_concurrency_trip_at_the_lease_peak_refused" {
  command = plan
  variables {
    breaker_dws_concurrency = 2
  }
  expect_failures = [var.breaker_dws_concurrency]
}

run "dws_duration_trip_at_the_backfill_peak_refused" {
  command = plan
  variables {
    breaker_dws_duration_ms_per_hour = 4500000
  }
  expect_failures = [var.breaker_dws_duration_ms_per_hour]
}

run "invocation_trips_bounded" {
  command = plan
  variables {
    breaker_api_invocations_per_5min = 100000
    breaker_dws_invocations_per_5min = 5
  }
  expect_failures = [var.breaker_api_invocations_per_5min, var.breaker_dws_invocations_per_5min]
}

# --- What a flat-rate plan allows, with every feature on --------------------------

run "every_behaviour_flat_rate_compatible" {
  command = plan
  variables {
    site_enabled  = true
    auth_enabled  = true
    dws_enabled   = true
    nodes_enabled = true
  }

  assert {
    condition = alltrue([for b in concat(aws_cloudfront_distribution.site[0].default_cache_behavior, aws_cloudfront_distribution.site[0].ordered_cache_behavior) :
      b.response_headers_policy_id == null &&
      one([for f in b.function_association : f.function_arn if f.event_type == "viewer-response"]) == "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-response"
    ])
    error_message = "Every behaviour (default, /signin/*, /dws/*, /nodes-data/*, /api/*) sets its headers with site_response and carries no response-headers policy."
  }
  assert {
    condition = alltrue([for b in concat(aws_cloudfront_distribution.site[0].default_cache_behavior, aws_cloudfront_distribution.site[0].ordered_cache_behavior) :
      contains(["658327ea-f89d-4fab-a63d-7e88639e58f6", "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"], b.cache_policy_id) &&
      (b.origin_request_policy_id == null || b.origin_request_policy_id == "" || b.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac")
    ])
    error_message = "Only AWS's managed cache policies (CachingOptimized, CachingDisabled) and origin-request policy (AllViewerExceptHostHeader): custom ones need the Business plan."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.site[0].ordered_cache_behavior) + 1 <= 10
    error_message = "Pro allows 10 cache behaviours."
  }
}

# --- The flat-rate plan -------------------------------------------------------------

run "flat_rate_plan_off_by_default" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition     = length(aws_pricingplanmanager_subscription.cloudfront) == 0 && output.cloudfront_flat_rate_subscription == null
    error_message = "No flat-rate subscription unless cloudfront_flat_rate_plan asks for one."
  }
}

run "flat_rate_plan_pro" {
  command = plan
  variables {
    site_enabled              = true
    auth_enabled              = true
    dws_enabled               = true
    cloudfront_flat_rate_plan = "PRO"
  }

  assert {
    condition = (
      aws_pricingplanmanager_subscription.cloudfront[0].plan_family == "CloudFront" &&
      aws_pricingplanmanager_subscription.cloudfront[0].plan_tier == "PRO" &&
      aws_pricingplanmanager_subscription.cloudfront[0].approval_mode == "MANUAL"
    )
    error_message = "PRO is a CloudFront plan subscription, MANUAL: unbilled until the operator approves it."
  }
  assert {
    condition = aws_pricingplanmanager_subscription.cloudfront[0].resource_arns == toset([
      "arn:aws:cloudfront::000000000000:distribution/EDISTTEST",
      "arn:aws:wafv2:us-east-1:000000000000:global/webacl/ewr-compliance-site-acl/00000000-0000-0000-0000-000000000000",
      "arn:aws:route53:::hostedzone/Z0000000000000000000",
    ])
    error_message = "The plan covers the distribution, its web ACL and the site's zone, nothing else."
  }
}

run "flat_rate_plan_needs_the_site" {
  command = plan
  variables {
    cloudfront_flat_rate_plan = "PRO"
  }
  expect_failures = [var.cloudfront_flat_rate_plan]
}

run "flat_rate_plan_tier_refused" {
  command = plan
  variables {
    site_enabled              = true
    cloudfront_flat_rate_plan = "BUSINESS"
  }
  expect_failures = [var.cloudfront_flat_rate_plan]
}
