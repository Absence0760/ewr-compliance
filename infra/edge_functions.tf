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
#   2. A dot segment (/./, /../) gets 404, so no path resolves to the bucket
#      root, where ListBucket would list.
#   3. Folder paths get their page: /nodes/ is served /nodes/index.html, and
#      /nodes (no trailing slash, no extension) is a 301 to /nodes/, because
#      the pages use relative paths and must be loaded from the folder
#      (trailingSlash = 'always', src/routes/+layout.ts).
#
# The code is plain ES5 for cloudfront-js-2.0, and decodes base64 itself so
# it depends on nothing the runtime may lack. infra/scripts/edge-functions.test.ts
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

    function answer(code, description, headers, body) {
      headers['cache-control'] = { value: 'no-store' };
      var r = { statusCode: code, statusDescription: description, headers: headers };
      if (body !== undefined) r.body = { encoding: 'text', data: body };
      return r;
    }

    function unsigned(request) {
      if (request.headers['x-requested-with']) {
        return answer(401, 'Unauthorized', {
          'content-type': { value: 'application/json; charset=utf-8' },
          'x-content-type-options': { value: 'nosniff' }
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
        if (segments[i] === '.' || segments[i] === '..') {
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
