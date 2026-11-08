# ----------------------------------------------------------------------------
# Spend circuit breaker (decision Q6, docs/hosting.md § Cost controls; after
# pitman's breaker.tf). The budgets only mail, a day behind the spend, and a
# budget action can't throttle a Lambda (its targets are IAM policies, SCPs
# and EC2/RDS), so this stops a runaway function by itself:
#
#   trip alarms (below) ──► SNS ewr-compliance-breaker ──► Lambda ewr-compliance-breaker
#                      └──► alerts (mail)                  PutFunctionConcurrency 0 on the
#                                                          function the alarm watches
#
# It protects every Lambda this stack runs that something outside can make
# run: the API (auth.tf, with auth_enabled) and the DWS pipeline (dws.tf, with
# dws_enabled), each by itself. Three trips a function, two on what is billed
# (GB-seconds) and one on requests:
#
#   - ConcurrentExecutions (Maximum) >= the threshold in 3 consecutive
#     5-minute periods: saturation, stopped within ~15 minutes.
#   - Duration (Sum) over a clock hour > the threshold: a quieter or pulsed
#     load that never holds that many copies for 15 minutes, stopped in 1-2 h.
#   - Invocations (Sum) > the threshold in 3 consecutive 5-minute periods: a
#     flood of fast calls, which bills requests and log lines but almost no
#     Duration, stopped in ~15 minutes.
#
# The thresholds, from each function's own shape (variables.tf has the
# arithmetic; docs/hosting.md § Cost controls the monthly ceilings):
#
#   API, 256 MB, 10 s timeout, at most 10 copies (the account's limit) or
#   api_reserved_concurrency: >= 4 copies for 15 min; > 3 600 000 ms an hour
#   (one copy busy the whole hour); > 3 000 calls per 5 min for 15 min (10 a
#   second). A handful of people make a few calls a page and one renewal
#   every 15 minutes, and a sign-in step takes its 1-second floor.
#
#   DWS pipeline, 256 MB, 900 s timeout: >= 3 copies for 15 min;
#   > 5 400 000 ms an hour (1.5 copies busy the whole hour); > 60 calls per
#   5 min for 15 min. Its legitimate peak is the backfill (dws_backfill.tf),
#   which runs one window at a time, each up to its 900 s, with the daily run
#   or a pull by hand beside it at most. The lease (pipeline/src/lease.ts)
#   lets only one run work at a time, and any other ends at once with
#   LeaseBusy, so the most a legitimate hour holds is one copy busy the whole
#   hour, which Lambda's start-dated Duration can count as 4 500 000 ms (a
#   run begun in the hour's last second counts its whole 900 s there), two
#   copies for a moment, and a few calls per 5 minutes (a window a minute or
#   so, a LeaseBusy retry every 2 minutes). Each trip sits above that peak
#   (Duration by 900 000 ms, copies by one, calls ten times over), so neither
#   the backfill nor the schedule can trip it, and it is not exempted.
#
# Reset: `pnpm infra:breaker-reset` (tools/breaker-reset.sh). The trips are
# alarm_actions, which fire only on a transition into ALARM, so an alarm still
# in ALARM can't trip again: the script puts every breaker trip alarm back to
# OK first (re-arming them), then restores each function's reserved
# concurrency to Terraform's value. `terraform apply` also restores the
# concurrency (the functions own it, so the breaker's 0 is drift) but leaves
# the alarms in ALARM, unarmed. While the API is tripped it answers 429 and
# nobody can sign in; signed-in people keep the files until their 15-minute
# cookies lapse. While the pipeline is tripped the daily run's event goes to
# its DLQ (nothing to redrive: the next day's run does the same work) and a
# running backfill fails on Lambda's throttling; start the same plan again
# after the reset.
#
# The breaker's own concurrency: 1 reserved once the account's limit is
# raised (lambda_account_concurrency_limit), so the flood it stops can't
# starve it, and it can't run away itself. Until then (a new account's 10)
# nothing can be reserved: a flood holding all 10 copies throttles the
# breaker's invocation. Lambda retries a throttled asynchronous invocation
# with backoff for up to 6 hours, so it runs when a retry happens to find a
# free copy, which a flood that keeps all 10 busy may never leave, and after
# 6 hours the event is dropped. breaker-throttled (below) mails on the first
# throttle, so the operator knows to stop the function by hand; the durable
# fix is raising the limit, a go-live check (docs/hosting.md).
#
# Alarms on the same metrics that are NOT breaker trips, and never publish to
# its topic (their names are outside <project>-breaker-api-* and -dws-*):
# auth.tf's api-invocations, the mail-only early warning at 1 000 runs in one
# 5-minute period, below the trip's 3 000 in each of three; and
# api-direct-calls, which the go-live check fires once on purpose. Never set a
# breaker trip's state to ALARM by hand as a test: it would stop the
# function. The go-live check that proves the breaker invokes it directly,
# against the pipeline while its schedule is off (docs/hosting.md).
#
# Quota: once the account's limit is raised it must cover API reserved + DWS
# reserved (none) + this function's 1 + Lambda's 100 unreserved; the one rule
# for that is lambda_account_concurrency_limit's validation (variables.tf).
#
# Cost: the topic and the function are free at this volume (they run only on
# a trip); eight alarms with both functions (six trips, breaker-errors,
# breaker-throttled), about $0.80 a month.
# ----------------------------------------------------------------------------

locals {
  # Alarm-name prefix -> the function it stops, for the functions that exist.
  breaker_targets = merge(
    local.api_enabled ? { "${local.project}-breaker-api-" = local.api_function_name } : {},
    var.dws_enabled ? { "${local.project}-breaker-dws-" = local.dws_function_name } : {},
  )
  breaker = length(local.breaker_targets) > 0 ? 1 : 0

  # The same test as lambda_account_concurrency_limit's quota rule (variables.tf).
  breaker_reserved = var.lambda_account_concurrency_limit > 10 ? 1 : null

  breaker_function_name = "${local.project}-breaker"
  breaker_function_arns = [
    for name in values(local.breaker_targets) :
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${name}"
  ]
}

#trivy:ignore:AWS-0095
resource "aws_sns_topic" "breaker" {
  count = local.breaker
  name  = "${local.project}-breaker"
}

# Only CloudWatch, for this account's trip alarms in this region (named
# <project>-breaker-api-* and -dws-*), may publish: no other alarm can trip
# the breaker, the breaker-errors alarm included.
data "aws_iam_policy_document" "breaker_publish" {
  count = local.breaker

  statement {
    sid       = "AllowBreakerTripAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.breaker[0].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        for prefix in keys(local.breaker_targets) :
        "arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:${prefix}*"
      ]
    }
  }
}

resource "aws_sns_topic_policy" "breaker" {
  count  = local.breaker
  arn    = aws_sns_topic.breaker[0].arn
  policy = data.aws_iam_policy_document.breaker_publish[0].json
}

# --- The function -----------------------------------------------------------------

data "aws_iam_policy_document" "breaker_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "breaker" {
  count              = local.breaker
  name               = "${local.project}-breaker"
  assume_role_policy = data.aws_iam_policy_document.breaker_assume_role.json
}

# Exactly one action on the protected functions: set their reserved
# concurrency. Plus its own log group. No DeleteFunctionConcurrency (that
# would leave a function unreserved, uncapped), no sns:Publish (the alarms
# mail the operator), no invoke. infra/tests/cost.tftest.hcl (breaker_wiring)
# pins it.
data "aws_iam_policy_document" "breaker" {
  count = local.breaker

  statement {
    sid       = "StopProtectedFunctions"
    actions   = ["lambda:PutFunctionConcurrency"]
    resources = local.breaker_function_arns
  }

  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.breaker[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "breaker" {
  count  = local.breaker
  name   = "breaker"
  role   = aws_iam_role.breaker[0].id
  policy = data.aws_iam_policy_document.breaker[0].json
}

#trivy:ignore:AWS-0017
resource "aws_cloudwatch_log_group" "breaker" {
  count             = local.breaker
  name              = "/aws/lambda/${local.breaker_function_name}"
  retention_in_days = 90
}

data "archive_file" "breaker" {
  type        = "zip"
  source_file = "${path.module}/functions/breaker/index.mjs"
  output_path = "${path.module}/.terraform/breaker.zip"
}

#trivy:ignore:AWS-0066
resource "aws_lambda_function" "breaker" {
  count         = local.breaker
  function_name = local.breaker_function_name
  description   = "The spend breaker: sets a protected function's reserved concurrency to 0 when its trip alarm fires (infra/breaker.tf)."
  role          = aws_iam_role.breaker[0].arn

  filename         = data.archive_file.breaker.output_path
  source_code_hash = data.archive_file.breaker.output_base64sha256

  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 10

  # 1 once the account's limit is raised, none before (a new account's 10
  # must all stay unreserved): see the header.
  reserved_concurrent_executions = local.breaker_reserved

  logging_config {
    log_format            = "JSON"
    system_log_level      = "WARN"
    application_log_level = "INFO"
    log_group             = aws_cloudwatch_log_group.breaker[0].name
  }

  environment {
    variables = {
      PROTECTED = jsonencode(local.breaker_targets)
    }
  }

  depends_on = [aws_iam_role_policy.breaker]
}

resource "aws_lambda_permission" "breaker_sns" {
  count         = local.breaker
  statement_id  = "AllowBreakerTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.breaker[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.breaker[0].arn
}

resource "aws_sns_topic_subscription" "breaker" {
  count     = local.breaker
  topic_arn = aws_sns_topic.breaker[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.breaker[0].arn

  depends_on = [aws_lambda_permission.breaker_sns]
}

# --- The trips (the workload region, beside the functions) ---------------------------
# One set a protected function. Created whatever alarms_enabled says: they are
# the breaker, not notices.

locals {
  breaker_trips = merge(
    local.api_enabled ? {
      api = {
        function     = local.api_function_name
        what         = "The sign-in API"
        concurrency  = var.breaker_api_concurrency
        duration_ms  = var.breaker_api_duration_ms_per_hour
        invocations  = var.breaker_api_invocations_per_5min
        while_halted = "it answers 429 and nobody can sign in; signed-in people keep the files until their 15-minute cookies lapse"
      }
    } : {},
    var.dws_enabled ? {
      dws = {
        function     = local.dws_function_name
        what         = "The DWS pipeline"
        concurrency  = var.breaker_dws_concurrency
        duration_ms  = var.breaker_dws_duration_ms_per_hour
        invocations  = var.breaker_dws_invocations_per_5min
        while_halted = "daily runs go to its DLQ (purge it, nothing to redrive) and a running backfill fails; start the same plan again after the reset"
      }
    } : {},
  )

  breaker_reset_note = "Find the cause first, then re-arm and reopen with `pnpm infra:breaker-reset` (docs/hosting.md § Cost controls)."
}

resource "aws_cloudwatch_metric_alarm" "breaker_concurrency" {
  for_each            = local.breaker_trips
  alarm_name          = "${local.project}-breaker-${each.key}-concurrency"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "ConcurrentExecutions"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Maximum"
  threshold           = each.value.concurrency
  alarm_description   = "${each.value.what} (${each.value.function}) held ${each.value.concurrency} or more copies busy for 15 minutes. The breaker has set its reserved concurrency to 0: ${each.value.while_halted}. ${local.breaker_reset_note}"
  alarm_actions       = [aws_sns_topic.alerts.arn, aws_sns_topic.breaker[0].arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value.function
  }
}

resource "aws_cloudwatch_metric_alarm" "breaker_duration" {
  for_each            = local.breaker_trips
  alarm_name          = "${local.project}-breaker-${each.key}-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = each.value.duration_ms
  alarm_description   = "${each.value.what} (${each.value.function}) ran more than ${each.value.duration_ms} ms in a clock hour. The breaker has set its reserved concurrency to 0: ${each.value.while_halted}. ${local.breaker_reset_note}"
  alarm_actions       = [aws_sns_topic.alerts.arn, aws_sns_topic.breaker[0].arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value.function
  }
}

resource "aws_cloudwatch_metric_alarm" "breaker_invocations" {
  for_each            = local.breaker_trips
  alarm_name          = "${local.project}-breaker-${each.key}-invocations"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = each.value.invocations
  alarm_description   = "${each.value.what} (${each.value.function}) ran more than ${each.value.invocations} times in each of three 5-minute periods running. The breaker has set its reserved concurrency to 0: ${each.value.while_halted}. ${local.breaker_reset_note}"
  alarm_actions       = [aws_sns_topic.alerts.arn, aws_sns_topic.breaker[0].arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value.function
  }
}

# The breaker itself failed (it throws when a PutFunctionConcurrency is
# refused; SNS's async invoke retries twice): the function is still running,
# and stopping it by hand is the operator's.
resource "aws_cloudwatch_metric_alarm" "breaker_errors" {
  count               = local.breaker
  alarm_name          = "${local.project}-breaker-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The spend breaker failed to stop a function: it is still running. Stop it by hand now (docs/hosting.md § Cost controls: aws lambda put-function-concurrency ... 0), then read /aws/lambda/${local.breaker_function_name}."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.breaker[0].function_name
  }
}

# Throttled: at a new account's limit of 10 a flood can hold every copy, and
# the breaker's own invocation then waits on Lambda's retries (see the
# header). An alarm rather than an on-failure destination: it mails within
# 5 minutes of the first throttle, not after the 6 hours an event can wait,
# and it needs no sns:Publish in the breaker's role. Its name is outside the
# breaker topic's publishers.
resource "aws_cloudwatch_metric_alarm" "breaker_throttled" {
  count               = local.breaker
  alarm_name          = "${local.project}-breaker-throttled"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The spend breaker was throttled: every copy the account allows is busy, so it can't stop the function it was called for until a copy frees, and its call is dropped after 6 hours. Stop the function by hand now (docs/hosting.md § Cost controls), then raise the account's Lambda limit so the breaker reserves its own copy."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.breaker[0].function_name
  }
}
