# ----------------------------------------------------------------------------
# The DWS store (P4): our own copy of each linked gauge's DWS flow, kept
# current by a daily pull, served same-origin under /dws/ (after WM's
# ingest.tf mirror bucket and feeds.tf DWS pass)
#
# Only with var.dws_enabled. The shape:
#
#   EventBridge, daily (disabled until dws_schedule_enabled)
#        │ {"mode":"daily"}
#        ▼
#   pipeline Lambda (pipeline/, no VPC) ──GET, 1 a second──► DWS HyData.aspx
#        │                                                    (af-south-1 reaches it;
#        │                                                     other networks get 403)
#        ├─get─► config/stations.json   the station list (tools/dws-stations.sh, from the private repo)
#        ├─put─► raw/<station>/daily/<from>_<to>.txt   each page as sent
#        ├─put─► serve/dws/flows-<station>.json, serve/dws/index.json
#        ├─put─► state/status.json      per station, its last good and current pull
#        └─put─► lease/dws.json         one run at a time (pipeline/src/lease.ts)
#
#   CloudFront /dws/* (site.tf) ──OAC, origin_path /serve──► serve/dws/*
#
# The backfill (dws_backfill.tf) invokes the same function, one window at a
# time. A run stopped by DWS (403, throttling, its ScriptServer page, station
# after station unanswered) fails the invocation and is never retried: the
# async invoke config has no retries, its event goes to the DLQ, and the
# stopped and DLQ alarms say so; the next runs cool down before asking again
# (pipeline/src/run.ts coolingUntil). The lag alarm says the copy has stopped
# moving, whatever the reason.
#
# Station codes are client material: they live in the private repo, this
# bucket and the pipeline's log group, never in this repo, a workflow or an
# event (the backfill's items are date windows only).
# ----------------------------------------------------------------------------

locals {
  dws = var.dws_enabled ? 1 : 0

  dws_function_name = "${local.project}-dws"
  dws_bucket_name   = "${local.project}-dws-${data.aws_caller_identity.current.account_id}"
  dws_function_arn  = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.dws_function_name}"

  # The lag the daily run publishes (pipeline/src/run.ts lagMetricLine).
  dws_metric_namespace = "${local.project}/Dws"
  dws_lag_metric       = "DwsLagDays"

  # What the pipeline reads and writes, by prefix (pipeline/src/store.ts KEYS).
  dws_stations_key = "config/stations.json"
  dws_lease_key    = "lease/dws.json"
  dws_rw_prefixes  = ["raw/*", "serve/dws/*", "state/*"]

  dws_alarms = var.dws_enabled && var.alarms_enabled ? 1 : 0
}

# --- The store bucket -----------------------------------------------------------------

resource "aws_s3_bucket" "dws" {
  count  = local.dws
  bucket = local.dws_bucket_name
}

resource "aws_s3_bucket_public_access_block" "dws" {
  count                   = local.dws
  bucket                  = aws_s3_bucket.dws[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: written by one role and read by CloudFront through OAC, both this
# account's; a customer-managed key would need a key policy for CloudFront for
# no secrecy gained. Access is the signed-cookie gate (site.tf), as for the site.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "dws" {
  count  = local.dws
  bucket = aws_s3_bucket.dws[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "dws" {
  count  = local.dws
  bucket = aws_s3_bucket.dws[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioned: a merge written in error (DWS served a wrong page, a bug) can be
# rolled back object by object for 30 days, and every raw page a re-pull
# replaced is still there to compare against.
resource "aws_s3_bucket_versioning" "dws" {
  count  = local.dws
  bucket = aws_s3_bucket.dws[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "dws" {
  count  = local.dws
  bucket = aws_s3_bucket.dws[0].id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.dws]
}

# CloudFront may read serve/dws/* and nothing else: not the station list, the
# raw pages, the status or the lease. No ListBucket for it, so a missing file is
# S3's 403, which the distribution's custom error response answers with the
# sign-in page, as for an unsigned request; the app reads any failure of
# dws/index.json as "no store" with its status (src/lib/ewr/dwsStore.ts).
# The pipeline's own role grants are in its policy below, not here.
data "aws_iam_policy_document" "dws_bucket" {
  count = local.dws

  dynamic "statement" {
    for_each = var.site_enabled ? [1] : []
    content {
      sid       = "AllowCloudFrontReadServe"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.dws[0].arn}/serve/dws/*"]
      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.site[0].arn]
      }
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.dws[0].arn,
      "${aws_s3_bucket.dws[0].arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "dws" {
  count  = local.dws
  bucket = aws_s3_bucket.dws[0].id
  policy = data.aws_iam_policy_document.dws_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.dws]
}

# --- The DWS API key (no value: the operator puts it in) --------------------------------
# Created EMPTY, as WM's CDS key (era5land.tf): Terraform never sets or reads a
# value, so the key is never in state. For when DWS issues an API key (the
# plan's Q1); the HyData page needs none, and nothing reads it yet. The
# AWS-managed key: only the pipeline's role is granted GetSecretValue.
#trivy:ignore:AWS-0098
resource "aws_secretsmanager_secret" "dws_api_key" {
  count                   = local.dws
  name                    = "${local.project}/dws-api-key"
  description             = "The DWS API key, the key alone as the secret string, for the DWS store's pipeline (pipeline/). Terraform never sets a value: the operator puts it in with put-secret-value from a file (docs/hosting.md)."
  recovery_window_in_days = 7
}

# --- The async-invoke DLQ ----------------------------------------------------------------

# SQS-managed SSE: a failed run's event is {"mode":"daily"}, no client data.
#trivy:ignore:AWS-0135
resource "aws_sqs_queue" "dws_dlq" {
  count                     = local.dws
  name                      = "${local.project}-dws-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
}

# --- The pipeline Lambda (no VPC) ----------------------------------------------------------

resource "aws_iam_role" "dws" {
  count              = local.dws
  name               = "${local.project}-dws-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Each grant on its one resource. The bucket's prefixes are the pipeline's
# keys (pipeline/src/store.ts KEYS); the station list is read-only, and nothing
# is ever deleted (the lease is released by an expired overwrite).
data "aws_iam_policy_document" "dws" {
  count = local.dws

  statement {
    sid       = "ReadStationList"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.dws[0].arn}/${local.dws_stations_key}"]
  }

  statement {
    sid       = "ReadWriteStore"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [for p in local.dws_rw_prefixes : "${aws_s3_bucket.dws[0].arn}/${p}"]
  }

  # Taken with If-None-Match / If-Match, released by an expired overwrite with If-Match.
  statement {
    sid       = "Lease"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.dws[0].arn}/${local.dws_lease_key}"]
  }

  # Without it a missing key (the first run's status, a raw page not yet
  # pulled) answers 403 instead of 404, and the pipeline can't tell "not there"
  # from "refused". The bucket only holds this pipeline's own files.
  statement {
    sid       = "ListStore"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.dws[0].arn]
  }

  statement {
    sid       = "ReadDwsApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.dws_api_key[0].arn]
  }

  # Lambda's on-failure destination sends as the function's role.
  statement {
    sid       = "SendFailedRunsToDlq"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dws_dlq[0].arn]
  }

  # PutMetricData has no resource-level permissions; the namespace is the scope.
  statement {
    sid       = "PublishLag"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.dws_metric_namespace]
    }
  }

  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dws[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "dws" {
  count  = local.dws
  name   = "dws-store"
  role   = aws_iam_role.dws[0].id
  policy = data.aws_iam_policy_document.dws[0].json
}

# Station codes appear here only beside a failed page's fixed label
# (pipeline/src/run.ts), never a page's text.
#trivy:ignore:AWS-0017
resource "aws_cloudwatch_log_group" "dws" {
  count             = local.dws
  name              = "/aws/lambda/${local.dws_function_name}"
  retention_in_days = var.dws_log_retention_days
}

data "archive_file" "dws_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/dws_stub.zip"

  source {
    filename = "index.mjs"
    content  = <<-EOT
      export const handler = async () => {
        throw new Error("The DWS pipeline is not deployed yet. Run the deploy-lambdas workflow.");
      };
    EOT
  }
}

#trivy:ignore:AWS-0066
resource "aws_lambda_function" "dws" {
  count         = local.dws
  function_name = local.dws_function_name
  description   = "The DWS store's pipeline: pulls each linked gauge's daily flow from DWS into the store the site serves under /dws/ (pipeline/)."
  role          = aws_iam_role.dws[0].arn

  filename         = data.archive_file.dws_stub.output_path
  source_code_hash = data.archive_file.dws_stub.output_base64sha256

  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  # Lambda's longest: a run stops starting stations 30 s before it
  # (pipeline/src/handler.ts SAVE_MARGIN_MS), and its lease expires a minute
  # after (pipeline/src/lease.ts LEASE_MARGIN_MS).
  timeout     = 900
  memory_size = 256

  # Under Lambda's JSON format, with INFO kept: the lag metric is a raw stdout
  # line, which Lambda records at INFO (pipeline/src/run.ts emitLag).
  logging_config {
    log_format            = "JSON"
    system_log_level      = "WARN"
    application_log_level = "INFO"
    log_group             = aws_cloudwatch_log_group.dws[0].name
  }

  environment {
    variables = merge(
      {
        DWS_BUCKET             = aws_s3_bucket.dws[0].bucket
        DWS_API_KEY_SECRET_ARN = aws_secretsmanager_secret.dws_api_key[0].arn
      },
      var.dws_contact != "" ? { DWS_CONTACT = var.dws_contact } : {},
    )
  }

  depends_on = [aws_iam_role_policy.dws]

  lifecycle {
    # deploy-lambdas.yml uploads each release's code.
    ignore_changes = [filename, source_code_hash]
  }
}

# Lambda's own async queue: no retry (a run DWS stopped must not ask again;
# tomorrow's run does), an event older than an hour dropped, a failed run's
# event kept in the DLQ.
resource "aws_lambda_function_event_invoke_config" "dws" {
  count                        = local.dws
  function_name                = aws_lambda_function.dws[0].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.dws_dlq[0].arn
    }
  }
}

# --- The daily rule -------------------------------------------------------------------------
# 04:00 UTC, 06:00 in South Africa. Each station is pulled once a day at most
# (pipeline/src/run.ts REFRESH_HOURS), one request a second. Created with the
# store but DISABLED until dws_schedule_enabled, so it never runs the stub.

resource "aws_cloudwatch_event_rule" "dws_daily" {
  count               = local.dws
  name                = "${local.project}-dws-daily"
  description         = "The DWS store's daily pull ({\"mode\":\"daily\"}, pipeline/). Disabled until dws_schedule_enabled is set."
  schedule_expression = "cron(0 4 * * ? *)"
  state               = var.dws_schedule_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "dws_daily" {
  count = local.dws
  rule  = aws_cloudwatch_event_rule.dws_daily[0].name
  arn   = aws_lambda_function.dws[0].arn
  input = jsonencode({ mode = "daily" })

  # EventBridge's own retries are off too: one invocation a day.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "dws_daily" {
  count         = local.dws
  statement_id  = "AllowEventBridgeDwsDaily"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dws[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dws_daily[0].arn
}

# --- Alarms (the regional topic, alarms.tf) -----------------------------------------------

# Freshness: the oldest listed station's last current pull, in days, which
# the daily run publishes every run (a busy lease and a DWS stop included).
# Breaching on missing data, so a run that stopped running alarms too. Only
# with the schedule, or it would fire from the first apply.
resource "aws_cloudwatch_metric_alarm" "dws_lag" {
  count               = var.dws_schedule_enabled && var.alarms_enabled ? 1 : 0
  alarm_name          = "${local.project}-dws-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.dws_lag_metric
  namespace           = local.dws_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.dws_lag_alarm_days
  alarm_description   = "The DWS store's oldest listed station was last pulled current more than ${var.dws_lag_alarm_days} days ago, or the daily run published no lag for two days. Logs Insights on the ${local.dws_function_name} log group: filter event = \"dws_run\" or event = \"dws_station_failed\". stopped = refused means DWS answered HTTP 403: the run stopped on purpose, so don't re-run it by hand (docs/hosting.md). The site keeps serving the stored days, marked out of date."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Pipeline = "dws"
  }
}

# A run DWS stopped (a 403, throttling, the ScriptServer page, DWS not
# answering), daily or backfill: the pipeline logs its dws_run line at ERROR
# with the reason. Read from the log, not Lambda's Errors metric, which the
# backfill's expected waits (LeaseBusy, WindowUnfinished) also count.
resource "aws_cloudwatch_log_metric_filter" "dws_stopped" {
  count          = local.dws
  name           = "${local.project}-dws-stopped"
  log_group_name = aws_cloudwatch_log_group.dws[0].name
  pattern        = "{ $.message.event = \"dws_run\" && ($.message.stopped = \"refused\" || $.message.stopped = \"throttled\" || $.message.stopped = \"server_error\" || $.message.stopped = \"unavailable\") }"

  metric_transformation {
    name          = "DwsStopped"
    namespace     = local.dws_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

# A failure of the pipeline's own, not DWS's: an unexpected error (it leaves
# as PipelineFailed), the store or a bad event (StoreFormatError), or a
# backfill station's page (DwsStationsFailed). The handler logs each as a
# dws_error line (pipeline/src/handler.ts). A timeout reaches the DLQ (daily)
# or fails the backfill's execution, whose alarms say so.
resource "aws_cloudwatch_log_metric_filter" "dws_failed" {
  count          = local.dws
  name           = "${local.project}-dws-failed"
  log_group_name = aws_cloudwatch_log_group.dws[0].name
  pattern        = "{ $.message.event = \"dws_error\" }"

  metric_transformation {
    name          = "DwsFailed"
    namespace     = local.dws_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "dws_stopped" {
  count               = local.dws_alarms
  alarm_name          = "${local.project}-dws-stopped"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DwsStopped"
  namespace           = local.dws_metric_namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "DWS stopped a run of the pipeline: stopped = refused (HTTP 403), throttled, server_error (its ScriptServer page) or unavailable (station after station unanswered). Nothing retries it, and the next runs ask DWS nothing until the stop cools down (most of a day after a 403, an hour after the others). Logs Insights on the ${local.dws_function_name} log group: filter message.event = \"dws_run\". After a 403, don't run it by hand until the reason is understood (docs/hosting.md)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "dws_failed" {
  count               = local.dws_alarms
  alarm_name          = "${local.project}-dws-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DwsFailed"
  namespace           = local.dws_metric_namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The DWS pipeline failed for a reason of its own, not DWS's: the store (a bucket grant, an unreadable status or station list), or a backfill station's page (DwsStationsFailed). Logs Insights on the ${local.dws_function_name} log group: filter message.event = \"dws_error\" or message.event = \"dws_station_failed\"."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "dws_dlq" {
  count               = local.dws_alarms
  alarm_name          = "${local.project}-dws-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A daily DWS run failed and its event was dead-lettered. Nothing to redrive: the next day's run does the same work. Read the run's error in the ${local.dws_function_name} log group, then purge ${local.project}-dws-dlq to clear this alarm."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dws_dlq[0].name
  }
}
