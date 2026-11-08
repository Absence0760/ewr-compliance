# ----------------------------------------------------------------------------
# The gated site (P2): a private bucket behind CloudFront, every path signed
#
# Only with var.site_enabled. The shape:
#
#   default    → the site bucket through OAC, for requests carrying valid
#                CloudFront signed cookies only (trusted_key_groups). The
#                viewer-request function (edge_functions.tf) first sends a
#                request with no live CloudFront-Policy cookie to /signin/, or
#                answers it 401 JSON, and adds index.html to folder paths.
#   /signin/*  → the same bucket, unsigned: the sign-in page (static/signin/,
#                P3) must load for someone not signed in. Nothing else is
#                served unsigned.
#   /api/*     → the API Lambda's Function URL (auth.tf), only with
#                var.auth_enabled (P3). Unsigned at the edge: the API checks
#                its own session cookie on every call, and /api/auth/* must
#                answer someone not signed in.
#   /dws/*     → the DWS store's bucket (dws.tf) through OAC, only with
#                var.dws_enabled (P4). Signed exactly as the default: the
#                same key group and function. origin_path /serve, so
#                /dws/index.json is the key serve/dws/index.json; the bucket
#                lets CloudFront read serve/dws/* and nothing else.
#
# Signed cookies: the API (P3) signs a 15-minute custom policy for
# https://<domain>/* with the private key in the signing-key secret below,
# and sets CloudFront-Policy, CloudFront-Signature and CloudFront-Key-Pair-Id.
# CloudFront checks the signature against the key group's public keys
# (var.cloudfront_public_keys); the edge function only reads the policy's
# expiry, to send an expired or absent session to sign-in rather than a bare
# 403. It never decides access: the signature check does.
#
# A missing object: the bucket policy grants ListBucket, so S3 answers 404, not
# 403, and a CloudFront 403 always means "not signed" (the custom error
# response below turns it into the sign-in page). Under /dws/ alone a missing
# file is a 403 too: CloudFront may not list the store (dws.tf).
# ----------------------------------------------------------------------------

locals {
  site = var.site_enabled ? 1 : 0

  # AWS managed policies (stable IDs, the same in every account).
  cache_policy_caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  cache_policy_caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  origin_request_all_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

  # The API (auth.tf) and its /api/* behaviour.
  api_enabled = var.site_enabled && var.auth_enabled

  # The DWS store (dws.tf) and its /dws/* behaviour.
  dws_served = var.site_enabled && var.dws_enabled
}

# --- Bucket ----------------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  count = local.site
  # Bucket names are global; the account ID suffix avoids collisions.
  bucket = "${local.project}-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  count                   = local.site
  bucket                  = aws_s3_bucket.site[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: only CloudFront reads the bucket, through OAC, and a customer-managed
# key would need a key policy for it for no secrecy gained. Access is the
# signed-cookie gate, not the key.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  count  = local.site
  bucket = aws_s3_bucket.site[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "site" {
  count  = local.site
  bucket = aws_s3_bucket.site[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioned, so a bad deploy can be rolled back object by object. Replaced and
# deleted versions expire after 30 days: data withdrawn from the site is gone
# from the bucket a month later (the privacy notice's retention, P6).
resource "aws_s3_bucket_versioning" "site" {
  count  = local.site
  bucket = aws_s3_bucket.site[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  count  = local.site
  bucket = aws_s3_bucket.site[0].id

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

  depends_on = [aws_s3_bucket_versioning.site]
}

# Only this distribution, through OAC, may read. ListBucket makes a missing key
# a 404 rather than a 403. It can't expose a listing: a listing is a GET on the
# bucket root, which the edge function rewrites to /index.html, and the default
# behaviour forwards no query string (CachingOptimized, no origin request
# policy), so no list-type or prefix parameter reaches S3.
data "aws_iam_policy_document" "site_bucket" {
  count = local.site

  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site[0].arn}/*"]
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

  statement {
    sid       = "AllowCloudFrontList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site[0].arn]
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

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.site[0].arn,
      "${aws_s3_bucket.site[0].arn}/*",
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

resource "aws_s3_bucket_policy" "site" {
  count  = local.site
  bucket = aws_s3_bucket.site[0].id
  policy = data.aws_iam_policy_document.site_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- Certificate (us-east-1 for CloudFront), DNS-validated in the zone --------------

resource "aws_acm_certificate" "site" {
  count             = local.site
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.site_enabled ? {
    for dvo in aws_acm_certificate.site[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.site
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- Signing keys -------------------------------------------------------------------

resource "aws_cloudfront_public_key" "signing" {
  for_each = var.site_enabled ? var.cloudfront_public_keys : {}

  name        = "${local.project}-signing-${each.key}"
  comment     = "Verifies the session's CloudFront signed cookies"
  encoded_key = each.value
}

resource "aws_cloudfront_key_group" "signing" {
  count   = local.site
  name    = "${local.project}-signing"
  comment = "Trusted signers for every path but /signin/* and /api/*"
  items   = [for k in sort(keys(aws_cloudfront_public_key.signing)) : aws_cloudfront_public_key.signing[k].id]
}

# The private half of the key pair, which the API (P3) signs cookies with.
# Created EMPTY: Terraform never sets or reads a value, so the key is never in
# state. The operator puts it in from a file and deletes the file (H7). The
# AWS-managed key is enough: only the API's role will be granted GetSecretValue
# (P3), and a customer-managed key would add a policy for no gain.
#trivy:ignore:AWS-0098
resource "aws_secretsmanager_secret" "signing_key" {
  count                   = local.site
  name                    = "${local.project}/cloudfront-signing-key"
  description             = "The CloudFront key pair's private key (PEM) that signs the session cookies. The operator puts it in with put-secret-value from a file (infra/README.md, H7); Terraform never sets a value."
  recovery_window_in_days = 7
}

# --- Distribution ---------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "site" {
  count                             = local.site
  name                              = "${local.project}-site-oac"
  description                       = "OAC for the ${local.project} site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Stamped on every /api/* request; the API refuses a request without it, so a
# direct call to the Function URL (public by AWS design) gets past neither the
# WAF nor the API. Only with the API (P3), which reads the same value from its
# runtime secret (auth.tf).
resource "random_password" "api_origin_secret" {
  count   = local.api_enabled ? 1 : 0
  length  = 48
  special = false
}

resource "aws_cloudfront_distribution" "site" {
  count               = local.site
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${local.project} site"
  default_root_object = "index.html"
  # PriceClass_All: the only class with South African edges.
  price_class = "PriceClass_All"
  web_acl_id  = aws_wafv2_web_acl.site[0].arn
  aliases     = [var.domain_name]

  origin {
    domain_name              = aws_s3_bucket.site[0].bucket_regional_domain_name
    origin_id                = "s3-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
  }

  dynamic "origin" {
    for_each = local.api_enabled ? [1] : []
    content {
      domain_name = local.api_origin_host
      origin_id   = "lambda-api"
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
      custom_header {
        name  = "X-Origin-Secret"
        value = random_password.api_origin_secret[0].result
      }
    }
  }

  dynamic "origin" {
    for_each = local.dws_served ? [1] : []
    content {
      domain_name              = aws_s3_bucket.dws[0].bucket_regional_domain_name
      origin_id                = "s3-dws"
      origin_path              = "/serve"
      origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
    }
  }

  # Every path but the ones below: signed cookies only.
  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = local.cache_policy_caching_optimized
    trusted_key_groups     = [aws_cloudfront_key_group.signing[0].id]

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_request[0].arn
    }

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.site_response[0].arn
    }
  }

  # The sign-in page, unsigned. The same function: it skips the cookie check
  # under /signin/ and still adds index.html.
  ordered_cache_behavior {
    path_pattern           = "/signin/*"
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = local.cache_policy_caching_optimized

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_request[0].arn
    }

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.site_response[0].arn
    }
  }

  # /dws/* -> the DWS store (P4), signed as the default behaviour is. The
  # pipeline writes its files `private, no-cache`, so CloudFront keeps them for
  # CachingOptimized's minimum second, and the app revalidates the index.
  dynamic "ordered_cache_behavior" {
    for_each = local.dws_served ? [1] : []
    content {
      path_pattern           = "/dws/*"
      target_origin_id       = "s3-dws"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = local.cache_policy_caching_optimized
      trusted_key_groups     = [aws_cloudfront_key_group.signing[0].id]

      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.site_request[0].arn
      }

      function_association {
        event_type   = "viewer-response"
        function_arn = aws_cloudfront_function.site_response[0].arn
      }
    }
  }

  # /api/* -> the API (P3). CachingDisabled is essential: a cached API answer
  # would be served to another user. AllViewerExceptHostHeader forwards the
  # cookies, body, query and Origin, but not Host, which must be the Function
  # URL's for AWS to route it.
  dynamic "ordered_cache_behavior" {
    for_each = local.api_enabled ? [1] : []
    content {
      path_pattern             = "/api/*"
      target_origin_id         = "lambda-api"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = local.cache_policy_caching_disabled
      origin_request_policy_id = local.origin_request_all_except_host

      function_association {
        event_type   = "viewer-response"
        function_arn = aws_cloudfront_function.site_response[0].arn
      }
    }
  }

  # CloudFront's own 403 for a request without valid signed cookies becomes the
  # sign-in page, still with status 403 and never cached, for the case the edge
  # function's check doesn't catch (a forged or wrong-key cookie with a live
  # expiry). This applies to every behaviour, so the API (P3) answers "not
  # signed in" with 401, never 403, or its JSON would be replaced by this page.
  custom_error_response {
    error_code            = 403
    response_code         = 403
    response_page_path    = "/signin/index.html"
    error_caching_min_ttl = 0
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# --- DNS --------------------------------------------------------------------------------

resource "aws_route53_record" "site_a" {
  count   = local.site
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  count   = local.site
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}
