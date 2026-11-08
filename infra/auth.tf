# ----------------------------------------------------------------------------
# Sign-in and users (P3): the API Lambda, its user table and SES
#
# Only with var.auth_enabled (which needs site_enabled). The shape:
#
#   browser --/api/*--> CloudFront (WAF, X-Origin-Secret stamped, CachingDisabled; site.tf)
#     --> Function URL --> ewr-compliance-api (server/, on auth-kit)
#           |-- DynamoDB ewr-compliance-users: users, codes, throttles, revoked sessions, audit
#           |-- SES (af-south-1): the sign-in code, from no-reply@<domain>
#           `-- Secrets Manager: its runtime secret (below) and the signing key (site.tf, H7)
#
# The API signs the CloudFront cookies that open every other path for 15
# minutes, and re-reads the user on every call, so a removed user loses the
# API at once and the files within 15 minutes (issue Q3).
#
# Keys. The code key and the session key (auth-kit: at least 32 characters,
# different) and the origin secret are random_password values written to one
# Secrets Manager secret, the API's runtime secret, which only its role may
# read. Not the Lambda environment: lambda:GetFunctionConfiguration returns it
# in clear, and the CI deploy role holds that action (oidc.tf), so a key there
# would let CI forge a session. Not an empty secret for the operator to fill:
# Terraform can make these keys itself, and the estate standard accepts
# random_* values in state (encrypted, operator-only), as WM's CloudFront
# secret is. The secret's version is write-only (secret_string_wo), so the
# values sit in state once, in the random_password resources, not twice.
# Rotation: `terraform apply -replace=random_password.auth_session_key` (every
# session ends; people sign in again), `-replace=random_password.auth_code_key`
# (live codes and lockouts are forgotten, and later erasures get new
# pseudonyms). replace_triggered_by rewrites the secret in the same apply, and
# its new version_id in the environment cold-starts every instance onto it.
#
# The CloudFront private key stays the operator's (H7): an RSA key Terraform
# made would sit in state, and site.tf's secret is created empty for that.
#
# Code: Terraform creates the function with a stub that answers 503;
# .github/workflows/deploy-lambdas.yml uploads the real package (server/), and
# ignore_changes keeps apply from undoing it.
# ----------------------------------------------------------------------------

locals {
  auth = local.api_enabled ? 1 : 0

  api_function_name = "${local.project}-api"
  users_table_name  = "${local.project}-users"

  # The key that signs: the one named, or the only one.
  signing_key_name = (
    var.cloudfront_signing_key != "" ? var.cloudfront_signing_key :
    length(var.cloudfront_public_keys) == 1 ? one(keys(var.cloudfront_public_keys)) : ""
  )

  # https://<id>.lambda-url.<region>.on.aws/ -> the host, for site.tf's origin.
  api_origin_host = local.api_enabled ? trimsuffix(trimprefix(aws_lambda_function_url.api[0].function_url, "https://"), "/") : ""

  # auth-kit's DYNAMODB_IAM_ACTIONS (v0.1.1). No Scan, no BatchWriteItem, no
  # table management: TransactWriteItems is authorised through these.
  # infra/tests/auth.tftest.hcl pins the list; bump it with auth-kit.
  auth_kit_dynamodb_actions = [
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:ConditionCheckItem",
  ]
}

# --- The user table (auth-kit's single table) ---------------------------------
# String keys pk/sk, TTL on `ttl` (codes and throttles a day after use,
# revocations at the token's expiry, audit rows after about 24 months; TTL
# deletes within days, not at once), PITR (deleted items restorable for 35
# days: the privacy notice's backup period), deletion protection, on-demand.
# The AWS-owned key: only this account's roles reach the table, and a
# customer-managed key would add a policy for no gain.
#trivy:ignore:AWS-0025
resource "aws_dynamodb_table" "users" {
  count        = local.auth
  name         = local.users_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  deletion_protection_enabled = true
}

# --- Keys: the API's runtime secret ---------------------------------------------

resource "random_password" "auth_code_key" {
  count   = local.auth
  length  = 48
  special = false
}

resource "random_password" "auth_session_key" {
  count   = local.auth
  length  = 48
  special = false
}

#trivy:ignore:AWS-0098
resource "aws_secretsmanager_secret" "auth_runtime" {
  count                   = local.auth
  name                    = "${local.project}/auth-runtime"
  description             = "The API's code key, session key and CloudFront origin secret (JSON), read once per cold start by server/src/lambda.ts. Terraform writes it, write-only."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "auth_runtime" {
  count     = local.auth
  secret_id = aws_secretsmanager_secret.auth_runtime[0].id
  # Write-only: not in state or a plan. The keys must match
  # server/src/config.ts parseRuntimeSecret, which refuses a missing or extra one.
  secret_string_wo = jsonencode({
    AUTH_CODE_KEY    = random_password.auth_code_key[0].result
    AUTH_SESSION_KEY = random_password.auth_session_key[0].result
    ORIGIN_SECRET    = random_password.api_origin_secret[0].result
  })
  secret_string_wo_version = 1

  lifecycle {
    replace_triggered_by = [
      random_password.auth_code_key,
      random_password.auth_session_key,
      random_password.api_origin_secret,
    ]
  }
}

# --- The API Lambda ------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  count              = local.auth
  name               = "${local.project}-api-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Everything the API may do, each on its one resource.
data "aws_iam_policy_document" "api" {
  count = local.auth

  statement {
    sid       = "UserTable"
    actions   = local.auth_kit_dynamodb_actions
    resources = [aws_dynamodb_table.users[0].arn]
  }

  statement {
    sid     = "SendAsNoReplyOnly"
    actions = ["ses:SendEmail"]
    # SES v2 SendEmail authorises against the sending identity and the
    # configuration set, and in the sandbox also against each recipient's
    # verified identity, hence identity/* in this account and region (WM
    # ses.tf). The sender is pinned by ses:FromAddress.
    resources = [
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
      aws_sesv2_configuration_set.auth[0].arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mail_from_address]
    }
  }

  statement {
    sid     = "ReadOwnSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.auth_runtime[0].arn,
      aws_secretsmanager_secret.signing_key[0].arn,
    ]
  }

  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  count  = local.auth
  name   = "api"
  role   = aws_iam_role.api[0].id
  policy = data.aws_iam_policy_document.api[0].json
}

# Logs hold event names and opaque ids, never an address (server/src/app.ts).
#trivy:ignore:AWS-0017
resource "aws_cloudwatch_log_group" "api" {
  count             = local.auth
  name              = "/aws/lambda/${local.api_function_name}"
  retention_in_days = var.api_log_retention_days
}

data "archive_file" "api_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/api_stub.zip"

  source {
    filename = "index.mjs"
    content  = <<-EOT
      export const handler = async () => ({
        statusCode: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "The sign-in API is not deployed yet. Run the deploy-lambdas workflow." })
      });
    EOT
  }
}

#trivy:ignore:AWS-0066
resource "aws_lambda_function" "api" {
  count         = local.auth
  function_name = local.api_function_name
  role          = aws_iam_role.api[0].arn

  filename         = data.archive_file.api_stub.output_path
  source_code_hash = data.archive_file.api_stub.output_base64sha256

  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = 10
  memory_size   = 256

  # null: no reservation. A new account's concurrency limit can be 10, all of
  # which must stay unreserved, so a reservation would fail the apply.
  reserved_concurrent_executions = var.api_reserved_concurrency

  logging_config {
    log_format            = "JSON"
    system_log_level      = "WARN"
    application_log_level = "INFO"
    log_group             = aws_cloudwatch_log_group.api[0].name
  }

  environment {
    variables = {
      # Names and public values only: anyone with GetFunctionConfiguration
      # reads these. The keys are in the runtime secret.
      USERS_TABLE            = aws_dynamodb_table.users[0].name
      SITE_DOMAIN            = var.domain_name
      MAIL_FROM              = local.mail_from_address
      SES_CONFIGURATION_SET  = aws_sesv2_configuration_set.auth[0].configuration_set_name
      CLOUDFRONT_KEY_PAIR_ID = aws_cloudfront_public_key.signing[local.signing_key_name].id
      CLOUDFRONT_PUBLIC_KEY  = trimspace(var.cloudfront_public_keys[local.signing_key_name])
      RUNTIME_SECRET_ARN     = aws_secretsmanager_secret.auth_runtime[0].arn
      # Not read by the code: a new version changes it, so every instance
      # cold-starts onto the new keys.
      RUNTIME_SECRET_VERSION = aws_secretsmanager_secret_version.auth_runtime[0].version_id
      SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.signing_key[0].arn
    }
  }

  depends_on = [aws_iam_role_policy.api]

  lifecycle {
    ignore_changes = [filename, source_code_hash]

    precondition {
      condition     = contains(keys(var.cloudfront_public_keys), local.signing_key_name)
      error_message = "With more than one cloudfront_public_keys entry, set cloudfront_signing_key to the name of the one the API signs with."
    }
  }
}

# No `cors` block: the browser calls the site's own /api/*, never this URL.
# The provider adds the public-invoke permissions itself (WM lambda.tf). A
# direct call is refused by the API's origin-secret check.
resource "aws_lambda_function_url" "api" {
  count              = local.auth
  function_name      = aws_lambda_function.api[0].function_name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}

# --- SES: the sign-in email (after WM's ses.tf) ---------------------------------
#
#   From:       no-reply@<domain>    DKIM-signed (Easy DKIM, RSA 2048)
#   MAIL FROM:  mail.<domain>        MX -> feedback-smtp.<region>.amazonses.com, SPF
#   DMARC:      _dmarc.<domain>      var.dmarc_policy (none to start)
#
# Leaving the SES sandbox is the operator's (H8): until then SES delivers only
# to verified addresses.

locals {
  mail_from_address = "${var.mail_from_local_part}@${var.domain_name}"
  mail_from_domain  = "${var.mail_from_subdomain}.${var.domain_name}"

  # Easy DKIM's CNAME target: the newer opt-in regions use a regional domain.
  ses_regional_dkim_regions = [
    "af-south-1", "ap-south-2", "ap-southeast-3", "ap-southeast-5", "ca-west-1",
    "ap-northeast-3", "eu-south-1", "eu-central-2", "il-central-1", "me-central-1",
  ]
  ses_dkim_domain = contains(local.ses_regional_dkim_regions, var.aws_region) ? "dkim.${var.aws_region}.amazonses.com" : "dkim.amazonses.com"

  dmarc_record = join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    var.dmarc_report_email != "" ? "rua=mailto:${var.dmarc_report_email}" : "",
    "adkim=r",
    "aspf=r",
  ]))
}

resource "aws_sesv2_configuration_set" "auth" {
  count                  = local.auth
  configuration_set_name = local.project

  delivery_options {
    # The email carries a live sign-in code: refuse a receiving server that
    # can't do STARTTLS rather than send it in the clear.
    tls_policy = var.ses_tls_policy
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # An address that hard-bounces or complains is never mailed again, which
  # keeps the account's sending rights.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_configuration_set_event_destination" "auth_cloudwatch" {
  count                  = local.auth
  configuration_set_name = aws_sesv2_configuration_set.auth[0].configuration_set_name
  event_destination_name = "cloudwatch"

  event_destination {
    enabled              = true
    matching_event_types = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"]

    cloud_watch_destination {
      dimension_configuration {
        dimension_name          = "ses:configuration-set"
        dimension_value_source  = "MESSAGE_TAG"
        default_dimension_value = local.project
      }
    }
  }
}

resource "aws_sesv2_email_identity" "domain" {
  count                  = local.auth
  email_identity         = var.domain_name
  configuration_set_name = aws_sesv2_configuration_set.auth[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy DKIM always returns three tokens.
resource "aws_route53_record" "ses_dkim" {
  count   = local.auth * 3
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.${local.ses_dkim_domain}"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count            = local.auth
  email_identity   = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain = local.mail_from_domain
  # A missing MX falls back to amazonses.com rather than bouncing (DKIM still aligns).
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count   = local.auth
  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count   = local.auth
  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "dmarc" {
  count   = local.auth
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = [local.dmarc_record]
}

# --- Alarms (the regional topic) ----------------------------------------------------

locals {
  auth_alarms = var.alarms_enabled ? local.auth : 0
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-api-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The sign-in API Lambda failed (a crash or a timeout, not a refused request). Its log group, /aws/lambda/${local.api_function_name}, says which event."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.api[0].function_name
  }
}

# The Function URL is public and skips the WAF, so a flood sent straight to it
# is a billed run and a log line per request, which the budgets report only a
# day later. Two prompt signals: any call without CloudFront's origin secret
# (only someone who found the URL sends one; the Deploy readiness check of
# docs/hosting.md sends one on purpose, so this one mails only and never trips
# the breaker: its name is outside the breaker topic's <project>-breaker-api-*
# publishers), and a run count no handful of users reaches (api-invocations,
# below, mail only; the breaker's trip, breaker.tf, stops it).
resource "aws_cloudwatch_log_metric_filter" "api_origin_secret_rejected" {
  count          = local.auth
  name           = "${local.project}-api-origin-secret-rejected"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "\"api.origin_secret_rejected\""

  metric_transformation {
    name          = "ApiOriginSecretRejected"
    namespace     = local.project
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_origin_secret_rejected" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-api-direct-calls"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApiOriginSecretRejected"
  namespace           = local.project
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The sign-in API's Function URL was called without CloudFront's origin secret: someone has the URL and is calling it directly, past the WAF. Each call is refused (404) but billed. Expected once, from the Deploy readiness check (docs/hosting.md). If it keeps firing, see docs/hosting.md, \"If the API is flooded\"."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  depends_on = [aws_cloudwatch_log_metric_filter.api_origin_secret_rejected]
}

# The early warning on the run count, mail only: past
# api_invocations_alarm_per_5min (1 000) in one 5-minute period. The breaker's
# run-count trip (breaker.tf, breaker_api_invocations_per_5min, 3 000 in each
# of three periods) is what stops the API; this mails first, and mails for a
# flood that stays under the trip all month. Its name is outside the breaker
# topic's <project>-breaker-api-* publishers, so it can never trip it.
resource "aws_cloudwatch_metric_alarm" "api_invocations" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-api-invocations"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.api_invocations_alarm_per_5min
  alarm_description   = "The sign-in API ran more than ${var.api_invocations_alarm_per_5min} times in 5 minutes, far past a handful of users. Mail only: the spend breaker stops it past ${var.breaker_api_invocations_per_5min} in each of three 5-minute periods. With ${local.project}-api-direct-calls, someone is calling the Function URL directly; without it, through the site (the WAF's sampled requests, us-east-1, say from where). See docs/hosting.md, \"If the API is flooded\"."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.api[0].function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-ses-bounce-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.BounceRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.025
  alarm_description   = "SES bounce rate above 2.5% (AWS reviews the account at 5%). A listed address may be wrong; check the Users page."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-ses-complaint-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.ComplaintRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.0005
  alarm_description   = "SES complaint rate above 0.05% (AWS reviews the account at 0.1%). Someone is marking sign-in emails as spam."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# An address locked by wrong codes: someone guessing, or someone locking an
# admin out on purpose (issue risks). The log line carries an opaque subject,
# never the address; tools/recover-admin clears a lock.
resource "aws_cloudwatch_log_metric_filter" "auth_locked" {
  count          = local.auth
  name           = "${local.project}-auth-locked"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "\"auth.locked\""

  metric_transformation {
    name          = "AuthLocked"
    namespace     = local.project
    value         = "1"
    default_value = "0"
  }
}

# A sign-in step slower than its 1-second floor shows in the timing, which
# could say whether an address is listed (a send is slower than none). The API
# logs auth.slow; raise the floor (server/src/app.ts) if this fires.
resource "aws_cloudwatch_log_metric_filter" "auth_slow" {
  count          = local.auth
  name           = "${local.project}-auth-slow"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "\"auth.slow\""

  metric_transformation {
    name          = "AuthSlow"
    namespace     = local.project
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_slow" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-auth-slow"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuthSlow"
  namespace           = local.project
  period              = 3600
  statistic           = "Sum"
  threshold           = 3
  alarm_description   = "Sign-in steps took longer than their 1-second floor three times in an hour, so their timing may say whether an address is listed. Usually slow SES sends: raise the floor in server/src/app.ts."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  depends_on = [aws_cloudwatch_log_metric_filter.auth_slow]
}

resource "aws_cloudwatch_metric_alarm" "auth_locked" {
  count               = local.auth_alarms
  alarm_name          = "${local.project}-auth-locked"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuthLocked"
  namespace           = local.project
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "An address was locked after five wrong sign-in codes. If an admin can't sign in, tools/recover-admin clears it (docs/hosting.md, Access control)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  depends_on = [aws_cloudwatch_log_metric_filter.auth_locked]
}
