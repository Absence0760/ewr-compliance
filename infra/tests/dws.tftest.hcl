# Plan-only tests of the DWS store (dws.tf, dws_backfill.tf, the /dws/*
# behaviour in site.tf) against the same mocked providers as
# guardrails.tftest.hcl. Pinned here: dws_enabled off creates nothing; the
# daily rule stays disabled until dws_schedule_enabled, with the lag alarm;
# nothing retries a failed run (async invoke, the rule's target, and the
# backfill for a refusal); the pipeline's grants, each on its prefix or one
# resource; CloudFront reads serve/dws/* only, signed; and the deploy role may
# update the pipeline's code.
#
#   bin/check-infra.sh -filter=tests/dws.tftest.hcl

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

run "dws_off_creates_nothing" {
  command = plan
  variables {
    site_enabled = true
  }

  assert {
    condition = (
      length(aws_s3_bucket.dws) + length(aws_lambda_function.dws) + length(aws_iam_role.dws) + length(aws_sqs_queue.dws_dlq) +
      length(aws_secretsmanager_secret.dws_api_key) + length(aws_cloudwatch_event_rule.dws_daily) + length(aws_cloudwatch_event_target.dws_daily) +
      length(aws_sfn_state_machine.dws_backfill) + length(aws_iam_role.dws_backfill) + length(aws_cloudwatch_metric_alarm.dws_lag) +
      length(aws_cloudwatch_metric_alarm.dws_stopped) + length(aws_cloudwatch_metric_alarm.dws_failed) + length(aws_cloudwatch_metric_alarm.dws_dlq) + length(aws_cloudwatch_metric_alarm.dws_backfill_failed)
    ) == 0
    error_message = "dws_enabled is off by default: no store, no pipeline, no backfill, no alarms."
  }
  assert {
    condition = (
      length([for o in aws_cloudfront_distribution.site[0].origin : o if o.origin_id == "s3-dws"]) == 0 &&
      length([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b if b.path_pattern == "/dws/*"]) == 0
    )
    error_message = "Without the store, the distribution has no /dws/* behaviour: /dws/ falls to the site bucket and is a 404."
  }
}

run "schedule_needs_the_store" {
  command = plan
  variables {
    dws_schedule_enabled = true
  }
  expect_failures = [var.dws_schedule_enabled]
}

run "rule_disabled_until_enabled" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition     = aws_cloudwatch_event_rule.dws_daily[0].state == "DISABLED"
    error_message = "The daily rule is created DISABLED: it must not run the stub, or pull before the station list is up."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dws_lag) == 0
    error_message = "No lag alarm without the schedule: it breaches on missing data and would fire from the first apply."
  }
  assert {
    condition     = aws_cloudwatch_event_rule.dws_daily[0].schedule_expression == "cron(0 4 * * ? *)" && jsondecode(aws_cloudwatch_event_target.dws_daily[0].input) == { mode = "daily" }
    error_message = "Once a day, at 06:00 SAST, in daily mode."
  }
}

run "rule_enabled_with_its_lag_alarm" {
  command = plan
  variables {
    dws_enabled          = true
    dws_schedule_enabled = true
  }

  assert {
    condition     = aws_cloudwatch_event_rule.dws_daily[0].state == "ENABLED"
    error_message = "dws_schedule_enabled turns the rule on."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dws_lag[0].namespace == "ewr-compliance/Dws" && aws_cloudwatch_metric_alarm.dws_lag[0].metric_name == "DwsLagDays" &&
      aws_cloudwatch_metric_alarm.dws_lag[0].dimensions["Pipeline"] == "dws" && aws_cloudwatch_metric_alarm.dws_lag[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dws_lag[0].threshold == 3
    )
    error_message = "The lag alarm reads the metric the pipeline publishes (pipeline/src/run.ts lagMetricLine), and breaches when it stops."
  }
}

run "no_retries" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition = (
      aws_lambda_function_event_invoke_config.dws[0].maximum_retry_attempts == 0 &&
      aws_lambda_function_event_invoke_config.dws[0].destination_config[0].on_failure[0].destination == "arn:aws:sqs:af-south-1:000000000000:ewr-compliance-dws-dlq"
    )
    error_message = "A failed run is never retried by Lambda: it goes to the DLQ."
  }
  assert {
    condition     = aws_cloudwatch_event_target.dws_daily[0].retry_policy[0].maximum_retry_attempts == 0
    error_message = "Nor by EventBridge."
  }
}

run "backfill_never_retries_a_refusal" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.dws_backfill[0].definition).States.Windows.MaxConcurrency == 1
    error_message = "One window at a time."
  }
  assert {
    condition = alltrue([for r in jsondecode(aws_sfn_state_machine.dws_backfill[0].definition).States.Windows.ItemProcessor.States.Pull.Retry :
      length(setintersection(toset(r.ErrorEquals), toset(["DwsRefused", "DwsThrottled", "DwsServerError", "DwsDown", "DwsCoolingDown", "DwsStationsFailed", "StoreFormatError", "PipelineFailed", "States.ALL", "States.TaskFailed"]))) == 0
    ])
    error_message = "No way DWS stops a run is retried (a 403 above all), nor a failed station page or a bad request: the execution fails and alarms."
  }
  assert {
    condition = toset(flatten([for r in jsondecode(aws_sfn_state_machine.dws_backfill[0].definition).States.Windows.ItemProcessor.States.Pull.Retry : r.ErrorEquals])) == toset([
      "Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException", "LeaseBusy", "WindowUnfinished",
    ])
    error_message = "Only waits that ask DWS nothing are retried: Lambda's own errors, the lease, and the time running out."
  }
  assert {
    condition     = jsondecode(aws_sfn_state_machine.dws_backfill[0].definition).States.Windows.ItemProcessor.States.Pace.Seconds == 60
    error_message = "A pause after each window."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.dws_backfill.statement : s.actions])) == toset(["lambda:InvokeFunction"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.dws_backfill.statement : s.resources])) == toset([
        "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws",
        "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws:*",
      ])
    )
    error_message = "The backfill may invoke the pipeline and nothing else."
  }
}

run "pipeline_iam_is_scoped" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition = { for s in data.aws_iam_policy_document.dws[0].statement : s.sid => toset(s.resources) } == {
      ReadStationList     = toset(["arn:aws:s3:::ewr-compliance-dws-000000000000/config/stations.json"])
      ReadWriteStore      = toset(["arn:aws:s3:::ewr-compliance-dws-000000000000/raw/*", "arn:aws:s3:::ewr-compliance-dws-000000000000/serve/dws/*", "arn:aws:s3:::ewr-compliance-dws-000000000000/state/*"])
      Lease               = toset(["arn:aws:s3:::ewr-compliance-dws-000000000000/lease/dws.json"])
      ListStore           = toset(["arn:aws:s3:::ewr-compliance-dws-000000000000"])
      ReadDwsApiKey       = toset(["arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/dws-api-key-AbCdEf"])
      SendFailedRunsToDlq = toset(["arn:aws:sqs:af-south-1:000000000000:ewr-compliance-dws-dlq"])
      PublishLag          = toset(["*"])
      OwnLogs             = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/ewr-compliance-dws:*"])
    }
    error_message = "Each grant on its prefix or its one resource."
  }
  assert {
    condition = { for s in data.aws_iam_policy_document.dws[0].statement : s.sid => toset(s.actions) } == {
      ReadStationList     = toset(["s3:GetObject"])
      ReadWriteStore      = toset(["s3:GetObject", "s3:PutObject"])
      Lease               = toset(["s3:GetObject", "s3:PutObject"])
      ListStore           = toset(["s3:ListBucket"])
      ReadDwsApiKey       = toset(["secretsmanager:GetSecretValue"])
      SendFailedRunsToDlq = toset(["sqs:SendMessage"])
      PublishLag          = toset(["cloudwatch:PutMetricData"])
      OwnLogs             = toset(["logs:CreateLogStream", "logs:PutLogEvents"])
    }
    error_message = "The station list is read-only to the pipeline, and it deletes nothing."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.dws[0].statement :
    one(s.condition).variable == "cloudwatch:namespace" && one(one(s.condition).values) == "ewr-compliance/Dws" if s.sid == "PublishLag"])
    error_message = "The one '*' resource is PutMetricData, which has none, held to the pipeline's namespace."
  }
  assert {
    condition     = length([for a in flatten([for s in data.aws_iam_policy_document.dws[0].statement : s.actions]) : a if strcontains(a, "*")]) == 0
    error_message = "No wildcard action."
  }
}

run "no_key_or_station_in_the_environment" {
  command = plan
  variables {
    dws_enabled = true
    dws_contact = "ops@mail.ewr-test.net"
  }

  assert {
    condition = (
      length(aws_lambda_function.dws[0].environment[0].variables) == 3 &&
      aws_lambda_function.dws[0].environment[0].variables["DWS_BUCKET"] == "ewr-compliance-dws-000000000000" &&
      aws_lambda_function.dws[0].environment[0].variables["DWS_API_KEY_SECRET_ARN"] == "arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/dws-api-key-AbCdEf" &&
      aws_lambda_function.dws[0].environment[0].variables["DWS_CONTACT"] == "ops@mail.ewr-test.net"
    )
    error_message = "The bucket, the secret's name and the contact: no key and no station list."
  }
  assert {
    condition     = aws_lambda_function.dws[0].runtime == "nodejs24.x" && one(aws_lambda_function.dws[0].architectures) == "arm64" && aws_lambda_function.dws[0].timeout == 900 && aws_lambda_function.dws[0].handler == "index.handler"
    error_message = "Node 24 on arm64, Lambda's longest timeout, the bundle's handler (pipeline/scripts/build.mjs)."
  }
}

run "rejects_a_contact_that_is_not_an_address" {
  command = plan
  variables {
    dws_contact = "call me"
  }
  expect_failures = [var.dws_contact]
}

run "dws_behaviour_is_signed_and_reads_serve_only" {
  command = plan
  variables {
    site_enabled = true
    dws_enabled  = true
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b.path_pattern] == ["/signin/*", "/dws/*"]
    error_message = "With the store, /dws/* follows /signin/*."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
      b.target_origin_id == "s3-dws" && one(b.trusted_key_groups) == "kg-test" && b.response_headers_policy_id == "rhp-site" &&
      one(b.function_association).function_arn == "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-request" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD", "OPTIONS"])
    if b.path_pattern == "/dws/*"])
    error_message = "/dws/* is signed exactly as the default behaviour: the same key group, function and headers, read-only."
  }
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.site[0].origin :
      o.origin_path == "/serve" && o.domain_name == "ewr-compliance-dws-000000000000.s3.af-south-1.amazonaws.com"
    if o.origin_id == "s3-dws"]) && length([for o in aws_cloudfront_distribution.site[0].origin : o if o.origin_id == "s3-dws"]) == 1
    error_message = "The store's origin is its bucket through OAC, with origin_path /serve."
  }
  assert {
    condition = [for s in data.aws_iam_policy_document.dws_bucket[0].statement : s.resources if s.effect != "Deny"] == [
      toset(["arn:aws:s3:::ewr-compliance-dws-000000000000/serve/dws/*"])
    ]
    error_message = "CloudFront may read serve/dws/* only: never the station list, the raw pages, the status or the lease."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.dws_bucket[0].statement :
      s.actions == toset(["s3:GetObject"]) && one(s.condition).variable == "AWS:SourceArn" &&
    one(one(s.condition).values) == "arn:aws:cloudfront::000000000000:distribution/EDISTTEST" if s.effect != "Deny"])
    error_message = "GetObject only, for this distribution only."
  }
}

run "store_without_the_site" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.dws_bucket[0].statement : s if s.effect != "Deny"]) == 0
    error_message = "With no distribution, nothing but the pipeline reads the store."
  }
}

run "deploy_role_updates_the_pipeline_code" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.resources])) == toset([
      "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws",
    ])
    error_message = "With the store, the deploy role may update the pipeline, by ARN, and nothing else."
  }
}

run "alarms" {
  command = plan
  variables {
    dws_enabled = true
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dws_stopped[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      aws_cloudwatch_metric_alarm.dws_failed[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      aws_cloudwatch_metric_alarm.dws_dlq[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      aws_cloudwatch_metric_alarm.dws_backfill_failed[0].alarm_actions == toset(["arn:aws:sns:af-south-1:000000000000:ewr-compliance-prod-alerts"]) &&
      aws_cloudwatch_metric_alarm.dws_backfill_failed[0].metric_name == "ExecutionsFailed"
    )
    error_message = "A run DWS stopped, a failure of the pipeline's own, the DLQ and a failed backfill each page the regional topic."
  }
  assert {
    condition = alltrue([for v in ["refused", "throttled", "server_error", "unavailable"] :
    strcontains(aws_cloudwatch_log_metric_filter.dws_stopped[0].pattern, "$.message.stopped = \"${v}\"")])
    error_message = "The stopped alarm counts every way DWS stops a run (pipeline/src/errors.ts stopReason), from the dws_run log line."
  }
}
