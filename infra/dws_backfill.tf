# ----------------------------------------------------------------------------
# The DWS store's backfill (after WM's ingest_backfill.tf)
#
# A Step Functions state machine the operator starts by hand (no schedule)
# with the window list tools/dws-backfill-plan.mjs prints:
#
#   { "items": [ { "mode": "backfill", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, … ] }
#
# Date windows only: each item pulls that window for every station in the
# store's own config/stations.json, so no station code is ever in an
# execution's input or history.
#
# It invokes the pipeline Lambda (dws.tf) once per window, in order, one at a
# time (MaxConcurrency = 1), and waits dws_backfill_wait_seconds after each.
#
#   - Resumable: a station whose raw page for the window is stored is done
#     and skipped (pipeline/src/run.ts runBackfill), so a failed or stopped
#     execution is resumed by starting the same plan again.
#   - Never retried: every way DWS stops a run (DwsRefused, a 403: asking
#     again is what gets an address banned; DwsThrottled, which the client
#     already waited out as far as Retry-After and the run allowed;
#     DwsServerError, its ScriptServer page; DwsDown, station after station
#     unanswered), DwsCoolingDown (a recent run was stopped so; the pipeline
#     asks nothing until it lapses), DwsStationsFailed (a station's page
#     failed; look at the log first), StoreFormatError (a bad window or no
#     list), and anything else of the function's own. They fail the
#     execution, and the backfill_failed alarm says so; the operator resumes
#     it by starting the same plan again.
#   - Retried, as waits rather than failures, asking DWS nothing meanwhile:
#       Lambda's own service errors and throttling, after a minute;
#       LeaseBusy (the daily run holds the lease, at most its 15 minutes),
#         every 2 minutes for an hour;
#       WindowUnfinished (the invocation's time ran out; done stations are
#         skipped), after a minute.
#   - A plain (inline) Map: ~20 windows for 40 years at ~10 history events
#     each is far inside a Standard execution's 25,000.
# ----------------------------------------------------------------------------

locals {
  dws_backfill_name = "${local.project}-dws-backfill"
  # Lambda's own service errors (throttling, a transient API failure): retried; the function's errors aren't.
  dws_backfill_lambda_errors = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
}

data "aws_iam_policy_document" "dws_backfill_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    # Only this account's state machine of this name may assume it (confused deputy).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.dws_backfill_name}"]
    }
  }
}

resource "aws_iam_role" "dws_backfill" {
  count              = local.dws
  name               = local.dws_backfill_name
  assume_role_policy = data.aws_iam_policy_document.dws_backfill_assume_role.json
}

data "aws_iam_policy_document" "dws_backfill" {
  statement {
    sid     = "InvokePipelineOnly"
    actions = ["lambda:InvokeFunction"]
    # The function and its qualified forms (a version or alias), nothing else.
    resources = [local.dws_function_arn, "${local.dws_function_arn}:*"]
  }
}

resource "aws_iam_role_policy" "dws_backfill" {
  count  = local.dws
  name   = "invoke-dws-pipeline"
  role   = aws_iam_role.dws_backfill[0].id
  policy = data.aws_iam_policy_document.dws_backfill.json
}

# No logging_configuration: the execution history, which Step Functions keeps
# 90 days, holds each window's outcome and error. It holds no station code.
#trivy:ignore:AWS-0119
resource "aws_sfn_state_machine" "dws_backfill" {
  count    = local.dws
  name     = local.dws_backfill_name
  role_arn = aws_iam_role.dws_backfill[0].arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "DWS store backfill: one date window at a time for every listed station, a pause after each. Input: {\"items\": [{\"mode\": \"backfill\", \"from\", \"to\"}, …]} from tools/dws-backfill-plan.mjs."
    StartAt = "Windows"
    States = {
      Windows = {
        Type           = "Map"
        ItemsPath      = "$.items"
        MaxConcurrency = 1
        # The windows' answers aren't kept: the execution's history has them.
        ResultPath = null
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt         = "Pull"
          States = {
            Pull = {
              Type     = "Task"
              Resource = "arn:aws:states:::lambda:invoke"
              Parameters = {
                FunctionName = local.dws_function_arn
                Payload = {
                  "mode.$" = "$.mode"
                  "from.$" = "$.from"
                  "to.$"   = "$.to"
                }
              }
              # A little over the function's own 900 s.
              TimeoutSeconds = 960
              ResultPath     = null
              Retry = [{
                ErrorEquals     = local.dws_backfill_lambda_errors
                IntervalSeconds = 60
                MaxAttempts     = 3
                BackoffRate     = 2
                }, {
                ErrorEquals     = ["LeaseBusy"]
                IntervalSeconds = 120
                MaxAttempts     = 30
                BackoffRate     = 1
                }, {
                ErrorEquals     = ["WindowUnfinished"]
                IntervalSeconds = 60
                MaxAttempts     = 5
                BackoffRate     = 1
              }]
              Next = "Pace"
            }
            Pace = {
              Type    = "Wait"
              Seconds = var.dws_backfill_wait_seconds
              End     = true
            }
          }
        }
        End = true
      }
    }
  })

  depends_on = [aws_iam_role_policy.dws_backfill]
}

# A failed execution: a window that failed (a 403, a station's page, a
# throttle that outlasted the retries) ends the run. The lag alarm can't say
# so: the daily run keeps the newest days current throughout.
resource "aws_cloudwatch_metric_alarm" "dws_backfill_failed" {
  count               = local.dws_alarms
  alarm_name          = "${local.dws_backfill_name}-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExecutionsFailed"
  namespace           = "AWS/States"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A ${local.dws_backfill_name} execution failed: a window's error ended it. Open the execution in Step Functions: the failed window's error is the execution's (DwsRefused = DWS answered HTTP 403, never re-run straight away; DwsThrottled, DwsServerError or DwsDown = DWS asked us to slow down or was down; DwsCoolingDown = a recent run was stopped so; DwsStationsFailed = a station's page failed, the ${local.dws_function_name} log names it and the check). Then resume: start the same plan again, which skips what is stored (docs/hosting.md)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.dws_backfill[0].arn
  }
}
