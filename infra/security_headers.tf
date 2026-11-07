# ----------------------------------------------------------------------------
# Response headers (CloudFront response-headers policies)
#
# site: what static/_headers set on Cloudflare Pages, now on every response
#   from the default and /signin/* behaviours, plus HSTS:
#     X-Content-Type-Options: nosniff
#     Content-Security-Policy: frame-ancestors 'none'
#     Referrer-Policy: strict-origin-when-cross-origin
#     Strict-Transport-Security: max-age=63072000; includeSubDomains
#   The page's own policy is SvelteKit's meta tag (vite.config.ts), with the
#   hash of its start-up script, which changes every build. This header adds
#   frame-ancestors, which a meta tag can't carry; two policies are enforced
#   together, so it can only tighten the page's. No preload: that's for a
#   registrable domain, and the parent isn't this project's to preload.
#
#   Cache-Control is NOT set here: it differs by file, so tools/deploy.sh sets
#   it on each object as it uploads (_app/immutable/* public and immutable,
#   everything else private, no-cache), and CloudFront passes it on.
#
# api: JSON from the API (P3): nothing in it may load, run or be framed.
#
# override = true everywhere, so no origin can weaken them.
# infra/tests/security_headers.tftest.hcl pins both.
# ----------------------------------------------------------------------------

locals {
  hsts_max_age_seconds = 63072000 # 2 years

  csp_api = join("; ", [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ])
}

resource "aws_cloudfront_response_headers_policy" "site" {
  count   = local.site
  name    = "${local.project}-site-headers"
  comment = "Site: frame-ancestors, nosniff, referrer policy, HSTS"

  security_headers_config {
    content_security_policy {
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "api" {
  count   = local.site
  name    = "${local.project}-api-headers"
  comment = "API JSON: default-src 'none', nosniff, no referrer, HSTS"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp_api
      override                = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }
}
