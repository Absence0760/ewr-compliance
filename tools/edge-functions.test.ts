// The CloudFront Functions in infra/edge_functions.tf, run as code. The Terraform tests can only look
// at their text, so here each heredoc is extracted, evaluated, and its handler called with events
// shaped as CloudFront's runtime 2.0 hands them over: site_request (viewer request) and
// site_response (viewer response, the security headers). It sits in tools/ because vitest collects
// tests there; it needs no AWS, only node.
import { readFileSync } from 'node:fs';
import { BASE_HEADERS } from '../server/src/http.ts';
import { describe, expect, it, vi, afterEach } from 'vitest';

const TF = readFileSync(new URL('../infra/edge_functions.tf', import.meta.url), 'utf8');

function code(name: string): string {
	const m = new RegExp(`resource "aws_cloudfront_function" "${name}" \\{[\\s\\S]*?code\\s*=\\s*<<-EOT\\n([\\s\\S]*?)\\n\\s*EOT`).exec(TF);
	if (!m) throw new Error(`No aws_cloudfront_function "${name}" with a <<-EOT code block`);
	const lines = m[1].split('\n');
	const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
	return lines.map((l) => l.slice(indent)).join('\n');
}

const SOURCE = code('site_request');
const { handler, decode } = new Function(`${SOURCE}\nreturn { handler: handler, decode: decode };`)() as {
	handler: (event: unknown) => Record<string, any>;
	decode: (s: string) => string | null;
};

/** CloudFront's URL-safe base64 of a canned-style custom policy expiring at `epoch`. */
function policy(epoch: unknown, resource = 'https://ewr.example.org/*'): string {
	const json = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': epoch } } }] });
	return Buffer.from(json).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
}

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const live = () => ({
	'CloudFront-Policy': { value: policy(NOW / 1000 + 900) },
	'CloudFront-Signature': { value: 'sig' },
	'CloudFront-Key-Pair-Id': { value: 'K123' }
});

function request(target: string, { cookies = {}, headers = {} }: { cookies?: Record<string, { value: string }>; headers?: Record<string, { value: string }> } = {}) {
	const q = target.indexOf('?');
	const raw = q === -1 ? undefined : target.slice(q + 1);
	// CloudFront hands each value over still encoded.
	const querystring: Record<string, { value: string }> = {};
	for (const part of raw ? raw.split('&') : []) {
		const eq = part.indexOf('=');
		if (part) querystring[eq === -1 ? part : part.slice(0, eq)] = { value: eq === -1 ? '' : part.slice(eq + 1) };
	}
	return {
		request: { method: 'GET', uri: q === -1 ? target : target.slice(0, q), querystring, headers, cookies, rawQueryString: () => raw },
		viewer: { ip: '198.51.100.7' }
	};
}

/** What the viewer gets: the URI sent to S3, or the function's own status. */
const outcome = (target: string, opts?: Parameters<typeof request>[1]) => {
	const r = handler(request(target, opts));
	return 'statusCode' in r ? r.statusCode : r.uri;
};

describe('site_request', () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	afterEach(() => vi.setSystemTime(NOW));

	it('stays within CloudFront Functions limits: 10 KB of code, plain ES5', () => {
		expect(Buffer.byteLength(SOURCE)).toBeLessThan(10 * 1024);
		expect(SOURCE).not.toMatch(/\b(let|const|class)\b|=>|`/);
		expect(SOURCE).not.toMatch(/\$\{/);
	});

	describe('signed in', () => {
		it('serves a folder path its index.html', () => {
			for (const [uri, s3] of [
				['/', '/index.html'],
				['/nodes/', '/nodes/index.html'],
				['/wma/some-wma/', '/wma/some-wma/index.html']
			])
				expect(outcome(uri, { cookies: live() }), uri).toBe(s3);
		});

		it('redirects a folder path without its slash, keeping the query', () => {
			const r = handler(request('/nodes?node=X1', { cookies: live() }));
			expect(r.statusCode).toBe(301);
			expect(r.headers.location.value).toBe('/nodes/?node=X1');
			expect(handler(request('/wma/x', { cookies: live() })).headers.location.value).toBe('/wma/x/');
		});

		it('passes files through unchanged, data and .mjs included', () => {
			for (const uri of ['/data/index.json', '/_app/immutable/workers/maplibre-gl-worker.abc.mjs', '/geo/rivers-x.json', '/404.html'])
				expect(outcome(uri, { cookies: live() }), uri).toBe(uri);
		});

		it('refuses dot segments, so nothing resolves to the bucket root', () => {
			for (const uri of ['/.', '/..', '/data/../', '/./index.html']) expect(outcome(uri, { cookies: live() }), uri).toBe(404);
		});

		it('refuses an empty segment, so a folder redirect never names another host', () => {
			for (const uri of ['//evil.example/x', '//evil.example', '/nodes//x', '///x']) expect(outcome(uri, { cookies: live() }), uri).toBe(404);
			expect(outcome('/nodes/', { cookies: live() })).not.toBe(404);
		});
	});

	describe('not signed in', () => {
		it('sends a page request to sign-in with where it was going', () => {
			const r = handler(request('/nodes/?node=X1'));
			expect(r.statusCode).toBe(302);
			expect(r.headers.location.value).toBe('/signin/?next=%2Fnodes%2F%3Fnode%3DX1');
			expect(r.headers['cache-control'].value).toBe('no-store');
		});

		it('gives the data the same answer as a page: nothing under data/ is served unsigned', () => {
			expect(outcome('/data/index.json')).toBe(302);
			expect(outcome('/')).toBe(302);
		});

		it("answers the app's own fetches with 401 JSON", () => {
			const r = handler(request('/data/index.json', { headers: { 'x-requested-with': { value: 'fetch' } } }));
			expect(r.statusCode).toBe(401);
			expect(r.headers['x-content-type-options'].value).toBe('nosniff');
			expect(r.headers['content-type'].value).toBe('application/json; charset=utf-8');
			expect(r.headers['cache-control'].value).toBe('no-store');
			expect(JSON.parse(r.body.data)).toEqual({ error: 'signin_required', signin: '/signin/' });
		});

		it('treats an expired, missing or unreadable policy as not signed in', () => {
			const expired = { ...live(), 'CloudFront-Policy': { value: policy(NOW / 1000 - 1) } };
			const { 'CloudFront-Signature': _, ...noSignature } = live();
			const cases: Record<string, { value: string }>[] = [
				expired,
				noSignature,
				{ ...live(), 'CloudFront-Key-Pair-Id': { value: '' } },
				{ ...live(), 'CloudFront-Policy': { value: 'not!base64' } },
				{ ...live(), 'CloudFront-Policy': { value: policy('2099999999') } },
				{ ...live(), 'CloudFront-Policy': { value: Buffer.from('{"Statement":[]}').toString('base64') } }
			];
			for (const cookies of cases) expect(outcome('/nodes/', { cookies })).toBe(302);
		});

		it('lets the sign-in page through, with its folder rewrite', () => {
			expect(outcome('/signin/')).toBe('/signin/index.html');
			expect(outcome('/signin/app.js')).toBe('/signin/app.js');
			expect(handler(request('/signin')).headers.location.value).toBe('/signin/');
		});

		it('does not let a look-alike path past the gate', () => {
			for (const uri of ['/signinx/', '/signin.html', '/x/signin/', '/data/signin/']) expect(outcome(uri), uri).toBe(302);
		});

		it('becomes signed out the moment the policy expires', () => {
			const cookies = live();
			expect(outcome('/nodes/', { cookies })).toBe('/nodes/index.html');
			vi.setSystemTime(NOW + 900_000);
			expect(outcome('/nodes/', { cookies })).toBe(302);
		});
	});

	describe('a signed URL, the operator check before sign-in exists', () => {
		const canned = (expires: number | string) => `/data/index.json?Expires=${expires}&Signature=abc&Key-Pair-Id=K123`;

		it('passes a canned or custom policy URL still in date', () => {
			expect(outcome(canned(NOW / 1000 + 60))).toBe('/data/index.json');
			expect(outcome(`/data/index.json?Policy=${policy(NOW / 1000 + 60)}&Signature=abc&Key-Pair-Id=K123`)).toBe('/data/index.json');
		});

		it('sends an expired, malformed or incomplete one to sign-in', () => {
			expect(outcome(canned(NOW / 1000 - 1))).toBe(302);
			expect(outcome(canned('soon'))).toBe(302);
			expect(outcome(`/data/index.json?Expires=${NOW / 1000 + 60}&Key-Pair-Id=K123`)).toBe(302);
			expect(outcome(`/data/index.json?Expires=${NOW / 1000 + 60}&Signature=abc`)).toBe(302);
			expect(outcome(`/data/index.json?Policy=${policy(NOW / 1000 - 1)}&Signature=abc&Key-Pair-Id=K123`)).toBe(302);
		});
	});

	it("decodes CloudFront's URL-safe base64 the same as node", () => {
		for (const text of ['', 'a', 'ab', 'abc', '{"Statement":[{"Resource":"https://x/*?"}]}', '~~>>??']) {
			const enc = Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
			expect(decode(enc), text).toBe(text);
		}
		expect(decode('a$b')).toBeNull();
	});
});

const ES5 = (source: string) => {
	expect(Buffer.byteLength(source)).toBeLessThan(10 * 1024);
	expect(source).not.toMatch(/\b(let|const|class)\b|=>|`/);
	expect(source).not.toMatch(/\$\{/);
};

/** The four headers the retired response-headers policies set, as CloudFront sent them. */
const SITE_HEADERS = {
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'content-security-policy': "frame-ancestors 'none'",
	'referrer-policy': 'strict-origin-when-cross-origin'
};
const API_HEADERS = {
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'referrer-policy': 'no-referrer'
};
const values = (headers: Record<string, { value: string }>, names: string[]) => Object.fromEntries(names.map((n) => [n, headers[n]?.value]));

describe('site_request answers carry the site headers', () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);

	it('on its 302, 401, 301 and 404, which site_response never sees', () => {
		const answers = [
			handler(request('/nodes/')),
			handler(request('/data/index.json', { headers: { 'x-requested-with': { value: 'fetch' } } })),
			handler(request('/nodes', { cookies: live() })),
			handler(request('/a/../b', { cookies: live() }))
		];
		expect(answers.map((r) => r.statusCode)).toEqual([302, 401, 301, 404]);
		for (const r of answers) expect(values(r.headers, Object.keys(SITE_HEADERS))).toEqual(SITE_HEADERS);
	});
});

describe('site_response', () => {
	const RESPONSE = code('site_response');
	const respond = (new Function(`${RESPONSE}\nreturn handler;`)() as (event: unknown) => { statusCode: number; headers: Record<string, { value: string }> });
	const event = (uri: string, headers: Record<string, { value: string }> = {}) => ({
		request: { method: 'GET', uri, querystring: {}, headers: {}, cookies: {} },
		response: { statusCode: 200, statusDescription: 'OK', headers, cookies: {} },
		viewer: { ip: '198.51.100.7' }
	});

	it('stays within CloudFront Functions limits: 10 KB of code, plain ES5', () => ES5(RESPONSE));

	it('sets the site headers on every path but /api/, exactly as the policy did', () => {
		for (const uri of ['/index.html', '/nodes/index.html', '/signin/index.html', '/signin/signin.js', '/data/index.json', '/dws/index.json', '/_app/immutable/workers/x.mjs', '/apiary/index.html']) {
			const r = respond(event(uri));
			expect(r.statusCode, uri).toBe(200);
			expect(r.headers, uri).toEqual(Object.fromEntries(Object.entries(SITE_HEADERS).map(([k, v]) => [k, { value: v }])));
		}
	});

	it('sets the API headers under /api/', () => {
		for (const uri of ['/api/me', '/api/auth/code', '/api/users']) {
			expect(values(respond(event(uri)).headers, Object.keys(API_HEADERS)), uri).toEqual(API_HEADERS);
		}
	});

	it('overrides what the origin sent, and leaves its other headers alone, Cache-Control above all', () => {
		const r = respond(
			event('/data/index.json', {
				'referrer-policy': { value: 'unsafe-url' },
				'content-security-policy': { value: '' },
				'cache-control': { value: 'private, no-cache' },
				'content-type': { value: 'application/json' },
				etag: { value: '"abc"' }
			})
		);
		expect(values(r.headers, Object.keys(SITE_HEADERS))).toEqual(SITE_HEADERS);
		expect(r.headers['cache-control'].value).toBe('private, no-cache');
		expect(r.headers['content-type'].value).toBe('application/json');
		expect(r.headers.etag.value).toBe('"abc"');
	});

	it('matches what the API sends itself on every answer (server/src/http.ts), which covers its 4xx', () => {
		const api = Object.fromEntries(Object.entries(BASE_HEADERS).map(([k, v]) => [k.toLowerCase(), v]));
		expect(values(Object.fromEntries(Object.entries(api).map(([k, v]) => [k, { value: v }])), Object.keys(API_HEADERS))).toEqual(API_HEADERS);
	});
});
