# ----------------------------------------------------------------------------
# site_request: the viewer-request CloudFront Function on the default and
# /signin/* behaviours (site.tf)
#
#   1. Outside /signin/, a request without a live session is answered here:
#        - with X-Requested-With (the app's own fetches): 401 JSON, so the app
#          can send the person to sign in rather than parse a page as data;
#        - otherwise: 302 to /signin/?next=<the path and query asked for>.
#      "Live" means the three CloudFront signed-cookie names are present and
#      the policy's DateLessThan is still in the future, or the request is a
#      signed URL (Key-Pair-Id, Signature, and an Expires or Policy still in
#      the future), which is how the operator checks the gate before P3. That is a courtesy
#      check, for a clean sign-in redirect: it does not verify the signature.
#      CloudFront does, against the key group (trusted_key_groups), and a
#      cookie that passes here but fails there gets CloudFront's 403, which
#      site.tf's custom error response turns into the sign-in page.
#   2. A dot segment (/./, /../) or an empty one (//) gets 404, so no path
#      resolves to the bucket root, where ListBucket would list, and no folder
#      redirect can name another host (//evil.example/x → Location: //evil…).
#   3. Folder paths get their page: /nodes/ is served /nodes/index.html, and
#      /nodes (no trailing slash, no extension) is a 301 to /nodes/, because
#      the pages use relative paths and must be loaded from the folder
#      (trailingSlash = 'always', src/routes/+layout.ts).
#
#   4. Every answer it makes itself (the 302, 401, 301 and 404) carries the
#      site's security headers: site_response below never sees those.
#
# The code is plain ES5 for cloudfront-js-2.0, and decodes base64 itself so
# it depends on nothing the runtime may lack. tools/edge-functions.test.ts
# runs it (vitest), from this heredoc.
#
# Cost: $0.10 per million invocations.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_function" "site_request" {
  count   = local.site
  name    = "${local.project}-site-request"
  runtime = "cloudfront-js-2.0"
  comment = "Unsigned: 302 to /signin/ or 401 JSON; folder paths get index.html"
  publish = true
  code    = <<-EOT
    var SIGNIN = '/signin/';
    var COOKIES = ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id'];
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    // CloudFront's URL-safe base64: '-' for '+', '_' for '=', '~' for '/'.
    function decode(s) {
      var out = '';
      var acc = 0;
      var bits = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '_' || c === '=') break;
        var v = B64.indexOf(c === '-' ? '+' : c === '~' ? '/' : c);
        if (v === -1) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((acc >> bits) & 255);
          acc &= (1 << bits) - 1;
        }
      }
      return out;
    }

    function expiry(policy) {
      var text = decode(policy);
      if (text === null) return 0;
      try {
        var e = JSON.parse(text).Statement[0].Condition.DateLessThan['AWS:EpochTime'];
        return typeof e === 'number' ? e : 0;
      } catch (err) {
        return 0;
      }
    }

    function param(request, name) {
      var q = request.querystring || {};
      return q[name] && q[name].value ? q[name].value : '';
    }

    function live(request) {
      var now = Date.now();
      // A signed URL (the operator's check with aws cloudfront sign, before
      // the sign-in exists): a canned Expires or a custom Policy.
      if (param(request, 'Key-Pair-Id') && param(request, 'Signature')) {
        var expires = param(request, 'Expires');
        if (expires) return /^[0-9]{1,12}$/.test(expires) && parseInt(expires, 10) * 1000 > now;
        if (param(request, 'Policy')) return expiry(param(request, 'Policy')) * 1000 > now;
      }
      var cookies = request.cookies || {};
      for (var i = 0; i < COOKIES.length; i++) {
        if (!cookies[COOKIES[i]] || !cookies[COOKIES[i]].value) return false;
      }
      return expiry(cookies['CloudFront-Policy'].value) * 1000 > now;
    }

    function query(request) {
      var qs = typeof request.rawQueryString === 'function' ? request.rawQueryString() : undefined;
      return qs === undefined ? '' : '?' + qs;
    }

    // site_response (below) never runs on an answer made here, so these carry its headers themselves.
    var SECURITY = {
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'none'",
      'referrer-policy': 'strict-origin-when-cross-origin'
    };

    function answer(code, description, headers, body) {
      for (var name in SECURITY) headers[name] = { value: SECURITY[name] };
      headers['cache-control'] = { value: 'no-store' };
      var r = { statusCode: code, statusDescription: description, headers: headers };
      if (body !== undefined) r.body = { encoding: 'text', data: body };
      return r;
    }

    function unsigned(request) {
      if (request.headers['x-requested-with']) {
        return answer(401, 'Unauthorized', {
          'content-type': { value: 'application/json; charset=utf-8' }
        }, '{"error":"signin_required","signin":"/signin/"}');
      }
      return answer(302, 'Found', {
        location: { value: SIGNIN + '?next=' + encodeURIComponent(request.uri + query(request)) }
      });
    }

    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var signin = uri === '/signin' || uri.indexOf(SIGNIN) === 0;
      if (!signin && !live(request)) return unsigned(request);

      var segments = uri.split('/');
      for (var i = 0; i < segments.length; i++) {
        // An empty segment inside the path (//) too: the 301 below would otherwise send
        // //evil.example/x to Location: //evil.example/x/, another site.
        if (segments[i] === '.' || segments[i] === '..' || (segments[i] === '' && i > 0 && i < segments.length - 1)) {
          return answer(404, 'Not Found', { 'content-type': { value: 'text/plain; charset=utf-8' } }, 'Not Found');
        }
      }
      var last = segments[segments.length - 1];
      if (last === '') {
        request.uri = uri + 'index.html';
        return request;
      }
      if (last.indexOf('.') === -1) {
        return answer(301, 'Moved Permanently', { location: { value: uri + '/' + query(request) } });
      }
      return request;
    }
  EOT
}

# ----------------------------------------------------------------------------
# site_response: the viewer-response CloudFront Function on every behaviour
# (site.tf), which sets the security headers. It replaced the two
# response-headers policies (decision Q7, docs/hosting.md § Cost controls):
# CloudFront's flat-rate Free and Pro plans allow only AWS's managed
# response-headers policies, and custom ones need Business ($200 a month).
#
#   site (every path but /api/*), the retired static/_headers file's three
#   plus HSTS:
#     Strict-Transport-Security: max-age=63072000; includeSubDomains
#     X-Content-Type-Options: nosniff
#     Content-Security-Policy: frame-ancestors 'none'
#     Referrer-Policy: strict-origin-when-cross-origin
#   The page's own policy is SvelteKit's meta tag (vite.config.ts), with the
#   hash of its start-up script; this adds frame-ancestors, which a meta tag
#   can't carry. Two policies are enforced together, so it only tightens.
#   No preload: that is for a registrable domain, and the parent isn't this
#   project's to preload.
#
#   api (/api/*): JSON, nothing in it may load, run or be framed:
#     the same HSTS and nosniff, Content-Security-Policy: default-src 'none';
#     base-uri 'none'; form-action 'none'; frame-ancestors 'none', and
#     Referrer-Policy: no-referrer.
#
# Each header is set over whatever the origin sent, as the policies'
# override = true did. Cache-Control is not touched: it differs by file, and
# tools/deploy.sh sets it on each object as it uploads.
#
# Where a function can't reach. CloudFront never runs a viewer-response
# function when the origin answers 400 or more, nor on an answer a
# viewer-request function made. So:
#   - site_request's own answers set the site's headers themselves (above);
#   - the API sets its four on every answer, refusals included
#     (server/src/http.ts BASE_HEADERS);
#   - left without them: S3's own 404 (and the store's 403) XML error bodies,
#     the sign-in page CloudFront serves for its own 403 (a cookie whose
#     signature fails; site.tf custom_error_response), WAF's 429 JSON and
#     CloudFront's own 5xx. The policies covered those. What it costs:
#     docs/hosting.md § Headers.
#
# One function serves every behaviour of the one distribution. A flat-rate
# plan forbids a function shared with another distribution, so it is never
# associated with any other. Plain ES5 for cloudfront-js-2.0, well under the
# 10 KB limit; tools/edge-functions.test.ts runs it and checks the size, and
# infra/tests/security_headers.tftest.hcl pins its wiring.
#
# Cost: $0.10 per million invocations (one more per request than the
# policies, which were free), included in a flat-rate plan.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_function" "site_response" {
  count   = local.site
  name    = "${local.project}-site-response"
  runtime = "cloudfront-js-2.0"
  comment = "Security headers: the site's, or the API's under /api/"
  publish = true
  code    = <<-EOT
    var HSTS = 'max-age=63072000; includeSubDomains';
    var SITE = {
      'strict-transport-security': HSTS,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'none'",
      'referrer-policy': 'strict-origin-when-cross-origin'
    };
    var API = {
      'strict-transport-security': HSTS,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer'
    };

    function handler(event) {
      var response = event.response;
      var set = event.request.uri.indexOf('/api/') === 0 ? API : SITE;
      for (var name in set) response.headers[name] = { value: set[name] };
      return response;
    }
  EOT
}
