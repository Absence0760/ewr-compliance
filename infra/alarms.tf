# ----------------------------------------------------------------------------
# Alert topics, budgets and cost anomaly detection (after WM's alarms.tf)
#
# The bootstrap creates no budgets: a new member account can't until "IAM
# access to billing information" is on in the account itself, a root toggle
# (infra/README.md, H5). Until then set budget_monthly_usd = 0, or the apply
# fails with AccessDeniedException on the budgets.
#
# Two topics with the same subscriber:
#   - alerts (var.aws_region): the regional CloudWatch alarms the Lambdas and
#     the DWS store add in P3 and P4.
#   - alerts_us_east_1: the CloudFront and WAF alarms (their metrics are only
#     in us-east-1, and an alarm notifies a topic in its own region), and the
#     budgets and Cost Anomaly Detection, which run from us-east-1; AWS doesn't
#     document Budgets reaching a topic in an opt-in region like af-south-1.
#
# Not KMS-encrypted: Budgets and CloudWatch can publish to an encrypted topic
# only through a customer-managed key whose policy grants them, and the
# messages are threshold notices with no client data.
# ----------------------------------------------------------------------------

#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts" {
  name = "${local.project}-prod-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# Only this account's alarms in this region may publish (the confused-deputy
# guard, AWS's own example shape).
data "aws_iam_policy_document" "alerts_publish" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
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
      values   = ["arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_publish.json
}

#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.project}-prod-alerts"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# One statement a publishing service, each pinned to this account, with the
# conditions AWS documents for it. Cost Anomaly Detection's documented example
# has SourceAccount only: a guessed SourceArn would drop every alert silently.
data "aws_iam_policy_document" "alerts_us_east_1_publish" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
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
      values   = ["arn:aws:cloudwatch:us-east-1:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }

  statement {
    sid       = "AllowBudgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:*"]
    }
  }

  statement {
    sid       = "AllowCostAnomalyDetection"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts_us_east_1" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.alerts_us_east_1.arn
  policy   = data.aws_iam_policy_document.alerts_us_east_1_publish.json
}

# --- Budgets -----------------------------------------------------------------
# Two (AWS gives two free an account), both to the us-east-1 topic:
#   - Monthly: FORECASTED 100% (silent until ~5 weeks of history), ACTUAL 80%
#     as the early warning, ACTUAL 100%.
#   - Daily: ACTUAL 100% only (daily budgets have no forecast), the first
#     month's guard.
# Billing data lags up to a day: the budgets say what a runaway cost, the
# alarms say it is happening.

locals {
  budget_daily_usd = (
    var.budget_daily_usd != null
    ? var.budget_daily_usd
    : ceil(var.budget_monthly_usd * 2.25 / 30)
  )
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  # The topic policy must grant Budgets before the budget validates its
  # subscriber, or the create fails with "Invalid SNS topic".
  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

resource "aws_budgets_budget" "daily" {
  count        = var.budget_monthly_usd > 0 && local.budget_daily_usd > 0 ? 1 : 0
  name         = "${local.project}-daily"
  budget_type  = "COST"
  limit_amount = tostring(local.budget_daily_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# --- Cost Anomaly Detection (free) ---------------------------------------------
# Off by default (cost_anomaly_threshold_usd = 0): an account may hold only one
# services monitor, and AWS may have made one, which would fail the first
# apply. Cost Explorer is served from us-east-1.

resource "aws_ce_anomaly_monitor" "services" {
  count             = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider          = aws.us_east_1
  name              = "${local.project}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "services" {
  count            = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider         = aws.us_east_1
  name             = "${local.project}-anomalies"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alerts_us_east_1.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.cost_anomaly_threshold_usd)]
    }
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# --- CloudFront alarms (us-east-1, with the site) ------------------------------

locals {
  site_alarms = var.site_enabled && var.alarms_enabled ? 1 : 0
}

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  count               = local.site_alarms
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "CloudFront 5xx rate above 1% over 5 minutes: the bucket, or from P3 the API, is failing."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.site[0].id
    Region         = "Global"
  }
}

# Nothing caps CloudFront's and WAF's request charges. The per-IP WAF limit
# stops one address, not many; this is the prompt signal for those, a day
# ahead of the budgets.
resource "aws_cloudwatch_metric_alarm" "cloudfront_requests" {
  count               = local.site_alarms
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-requests"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Requests"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Sum"
  threshold           = var.cloudfront_requests_alarm_per_5min
  alarm_description   = "CloudFront served more than ${var.cloudfront_requests_alarm_per_5min} requests in 5 minutes. Unsigned requests are answered by the edge function and still billed. The WAF console (us-east-1) shows the top IPs and paths in its sampled requests."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.site[0].id
    Region         = "Global"
  }
}
