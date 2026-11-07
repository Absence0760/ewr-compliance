# ----------------------------------------------------------------------------
# WAF: per-IP rate limits on the distribution (after WM's waf.tf)
#
# A CLOUDFRONT-scope ACL must be in us-east-1, hence the provider alias.
# Two rate rules, tightest first:
#   - /api/auth/*: var.waf_auth_rate_limit_per_ip (default 100) per 5
#     minutes. The sign-in endpoints (P3) are the only ones a stranger can
#     reach; auth-kit's per-address limits (3 tries a code, one send a
#     minute, 10 a day) hold whatever this does, and this stops one address
#     spraying many. Matched after URL-decoding, path normalisation and
#     lower-casing, so /api/%61uth/ and /API//auth/ count too.
#   - every path: var.waf_site_rate_limit_per_ip (default 2000), the backstop.
#     Unsigned requests are answered by the edge function, but each is still
#     a billed request; this caps one address.
# Both block with 429 JSON and Retry-After (never 403: see below).
# No AWS managed rule groups: nothing here takes a request body but sign-in,
# and the common rule set's body and size rules add cost for no gain.
#
# Cost: ~$5 a month for the ACL + $1 a rule + $0.60 a million requests.
# ----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "site" {
  count    = local.site
  provider = aws.us_east_1
  name     = "${local.project}-site-acl"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # A block answers 429 JSON, never WAF's default 403: the distribution swaps
  # every 403 for the sign-in page (site.tf), which would hide the limit from
  # the sign-in page and the app.
  custom_response_body {
    key          = "rate_limited"
    content      = "{\"error\":\"Too many requests from your network. Wait a few minutes and try again.\"}"
    content_type = "APPLICATION_JSON"
  }

  rule {
    name     = "RateLimitAuthPerIP"
    priority = 0

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate_limited"
          response_header {
            name  = "Retry-After"
            value = "300"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit              = var.waf_auth_rate_limit_per_ip
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-site-RateLimitAuthPerIP"
    }
  }

  rule {
    name     = "RateLimitSitePerIP"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate_limited"
          response_header {
            name  = "Retry-After"
            value = "300"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit              = var.waf_site_rate_limit_per_ip
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-site-RateLimitSitePerIP"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.project}-site-acl"
  }
}

# Sustained blocks: more than 100 in each of three 5-minute periods running is
# someone persisting (a code sprayer, a scraper) or a real user stuck behind a
# limit, such as an office behind one address. The ACL's sampled requests
# (us-east-1) say which. A CLOUDFRONT-scope ACL's metrics have no Region
# dimension.
resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  count               = local.site_alarms
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-waf-blocked-requests"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "The WAF blocked more than 100 requests in each of the last three 5-minute periods. /api/auth/ from many addresses is someone spraying sign-in codes; one address on other paths is a scraper, or a real user behind a shared address (raise waf_site_rate_limit_per_ip)."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = aws_wafv2_web_acl.site[0].visibility_config[0].metric_name
    Rule   = "ALL"
  }
}
