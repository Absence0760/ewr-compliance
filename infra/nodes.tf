# ----------------------------------------------------------------------------
# The admin node store (#17): the EWR nodes and files an admin loads on the
# site, shared with every signed-in user at once, served same-origin under
# /nodes-data/ and signed, as the DWS store is (dws.tf)
#
# Only with var.nodes_enabled, which needs the API (site_enabled and
# auth_enabled): the API is the store's only writer. The shape:
#
#   API Lambda (auth.tf, admin routes) ──get/put──► serve/nodes-data/index.json
#                                                   serve/nodes-data/wma-<wma>.json
#
#   CloudFront /nodes-data/* (site.tf) ──OAC, origin_path /serve──► serve/nodes-data/*
#
# One overlay file per WMA, plus an index of which WMAs have one. The app
# merges each overlay over the built-in data/index.json; nothing here is
# client material until an admin loads it, and the bucket is private like the
# site's.
#
# Nothing is ever deleted through the API: a deleted node is written into its
# WMA file (`deleted`), so the role has no DeleteObject, and every replaced
# version is kept a year for an operator to restore.
# ----------------------------------------------------------------------------

locals {
  nodes = local.nodes_served ? 1 : 0

  nodes_bucket_name = "${local.project}-nodes-${data.aws_caller_identity.current.account_id}"

  # The one prefix the API writes and CloudFront reads.
  nodes_serve_prefix = "serve/nodes-data/"
}

# --- The store bucket -----------------------------------------------------------------

resource "aws_s3_bucket" "nodes" {
  count  = local.nodes
  bucket = local.nodes_bucket_name
}

resource "aws_s3_bucket_public_access_block" "nodes" {
  count                   = local.nodes
  bucket                  = aws_s3_bucket.nodes[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: written by the API's role and read by CloudFront through OAC, both
# this account's; a customer-managed key would need a key policy for
# CloudFront for no secrecy gained. Access is the signed-cookie gate (site.tf).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "nodes" {
  count  = local.nodes
  bucket = aws_s3_bucket.nodes[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "nodes" {
  count  = local.nodes
  bucket = aws_s3_bucket.nodes[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioned, with replaced versions kept 365 days, not the site's and the DWS
# store's 30: an admin's wrong upload or delete replaces the WMA's only copy
# (nothing rebuilds it, unlike a re-pull or a redeploy), and may be noticed
# late. The operator restores it by copying the previous version back.
resource "aws_s3_bucket_versioning" "nodes" {
  count  = local.nodes
  bucket = aws_s3_bucket.nodes[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "nodes" {
  count  = local.nodes
  bucket = aws_s3_bucket.nodes[0].id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.nodes]
}

# CloudFront may read serve/nodes-data/* and nothing else. ListBucket makes a
# missing file there a 404, as on the DWS store: a 403 would get the sign-in
# page (the custom error response) and read as signed out (src/lib/users/
# siteFetch.ts), and a store with no overlay yet must read as "no overlays".
# It can't list or reveal anything: /nodes-data/* is the only path to this
# origin, its origin path puts every key under serve/nodes-data/, the edge
# function refuses dot and empty segments, and the behaviour forwards no query
# string (site.tf). The API's grants are in its own policy (auth.tf), not here.
data "aws_iam_policy_document" "nodes_bucket" {
  count = local.nodes

  statement {
    sid       = "AllowCloudFrontReadServe"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.nodes[0].arn}/${local.nodes_serve_prefix}*"]
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
    resources = [aws_s3_bucket.nodes[0].arn]
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
      aws_s3_bucket.nodes[0].arn,
      "${aws_s3_bucket.nodes[0].arn}/*",
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

resource "aws_s3_bucket_policy" "nodes" {
  count  = local.nodes
  bucket = aws_s3_bucket.nodes[0].id
  policy = data.aws_iam_policy_document.nodes_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.nodes]
}
