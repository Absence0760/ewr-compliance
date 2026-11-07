import { describe, expect, it } from 'vitest';
import { DwsRefusedError, DwsThrottledError, DwsUnavailableError } from './errors.ts';
import { MAX_BYTES, PoliteClient, retryAfterMs, USER_AGENT, userAgent } from './polite.ts';
import { clock } from './testing.ts';

const URL_A = 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx?Station=X0H001100.00';

/** A fetch answering from a list of replies in turn, recording when each request was sent and with what headers. */
function scripted(replies: (() => Response)[], now: () => number) {
	const sent: { at: number; url: string; headers: Record<string, string> }[] = [];
	const fetch = (async (input: URL | string, init?: RequestInit) => {
		sent.push({ at: now(), url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
		const next = replies.shift();
		if (!next) throw new Error('no more replies');
		return next();
	}) as typeof globalThis.fetch;
	return { fetch, sent };
}

const ok = (body = 'x', headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
const status = (s: number, headers: Record<string, string> = {}) => () => new Response(null, { status: s, headers });

describe('PoliteClient', () => {
	it('waits a second between requests, whatever the caller does', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([ok(), ok(), ok()], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await c.get(URL_A);
		await c.get(URL_A);
		t.advance(300);
		await c.get(URL_A);
		expect(sent.map((s) => s.at - sent[0]!.at)).toEqual([0, 1000, 2000]);
		expect(c.requests).toBe(3);
	});

	it('stops at the first 403, asking once and never again', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(403), ok()], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A)).rejects.toBeInstanceOf(DwsRefusedError);
		expect(sent).toHaveLength(1);
	});

	it('waits out a 429 for its Retry-After, then asks again', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(429, { 'Retry-After': '20' }), ok('table')], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A)).resolves.toMatchObject({ status: 200, body: 'table' });
		expect(sent[1]!.at - sent[0]!.at).toBe(20_000);
	});

	it('stops rather than wait longer than it may', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(503, { 'Retry-After': '600' }), ok()], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch, maxWaitMs: 120_000 });
		const err = await c.get(URL_A).catch((e) => e);
		expect(err).toBeInstanceOf(DwsThrottledError);
		expect(err.retryAfterSeconds).toBe(600);
		expect(sent).toHaveLength(1);
	});

	it("stops when the Lambda has no time left to wait, however short the wait", async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(429, { 'Retry-After': '5' }), ok()], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch, mayWait: () => false });
		await expect(c.get(URL_A)).rejects.toBeInstanceOf(DwsThrottledError);
		expect(sent).toHaveLength(1);
	});

	it('gives up on throttling after its retries, backing off when DWS gives no Retry-After', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(503), status(503), status(503), ok()], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch, maxRetries: 2, defaultBackoffMs: 10_000 });
		await expect(c.get(URL_A)).rejects.toBeInstanceOf(DwsThrottledError);
		expect(sent.map((s) => s.at - sent[0]!.at)).toEqual([0, 10_000, 30_000]);
	});

	it('sends its validators, and takes a 304 for unchanged', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch, sent } = scripted([status(304)], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A, { etag: '"a"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' })).resolves.toEqual({ status: 304 });
		expect(sent[0]!.headers).toMatchObject({ 'If-None-Match': '"a"', 'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT', 'User-Agent': USER_AGENT });
	});

	it('returns the validators DWS sends', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch } = scripted([ok('t', { ETag: '"b"', 'Last-Modified': 'Thu, 02 Jan 2025 00:00:00 GMT' })], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A)).resolves.toEqual({ status: 200, body: 't', etag: '"b"', lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT' });
	});

	it('refuses a body cut short of its Content-Length', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const short = () => new Response('only half', { status: 200, headers: { 'Content-Length': '200' } });
		const { fetch } = scripted([short], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A)).rejects.toMatchObject({ name: 'DwsUnavailable', label: 'page cut short' });
	});

	it('refuses a body larger than any daily table', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const { fetch } = scripted([ok('x'.repeat(MAX_BYTES + 1))], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch });
		await expect(c.get(URL_A)).rejects.toMatchObject({ label: 'page too large' });
	});

	it('follows a redirect on the same host, paced, and refuses one to anywhere else', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const same = scripted([status(302, { Location: '/Hydrology/Verified/HyData.aspx?x=1' }), ok('there')], t.now);
		const c = new PoliteClient({ now: t.now, sleep: t.sleep, fetch: same.fetch });
		await expect(c.get(URL_A)).resolves.toMatchObject({ body: 'there' });
		expect(same.sent[1]).toMatchObject({ url: 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx?x=1' });
		expect(same.sent[1]!.at - same.sent[0]!.at).toBe(1000);

		const away = scripted([status(302, { Location: 'https://elsewhere.example/' })], t.now);
		const d = new PoliteClient({ now: t.now, sleep: t.sleep, fetch: away.fetch });
		await expect(d.get(URL_A)).rejects.toMatchObject({ label: 'redirected away' });
	});

	it('takes a network failure or another status for that one page failing', async () => {
		const t = clock('2026-01-01T00:00:00Z');
		const fail = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof globalThis.fetch;
		await expect(new PoliteClient({ now: t.now, sleep: t.sleep, fetch: fail }).get(URL_A)).rejects.toBeInstanceOf(DwsUnavailableError);
		const { fetch } = scripted([status(500)], t.now);
		await expect(new PoliteClient({ now: t.now, sleep: t.sleep, fetch }).get(URL_A)).rejects.toMatchObject({ label: 'HTTP 500' });
	});
});

describe('userAgent', () => {
	it('names the project, and the contact only when it is an address', () => {
		expect(userAgent(undefined)).toBe(USER_AGENT);
		expect(userAgent('ops@mail.ewr-test.net')).toBe('ewr-compliance-pipeline/1 (+https://github.com/Absence0760/ewr-compliance; ops@mail.ewr-test.net)');
		expect(userAgent('not an address')).toBe(USER_AGENT);
		expect(userAgent('a@b.c) evil')).toBe(USER_AGENT);
	});
});

describe('retryAfterMs', () => {
	it('reads seconds and HTTP dates, and nothing else', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		expect(retryAfterMs('30', now)).toBe(30_000);
		expect(retryAfterMs('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60_000);
		expect(retryAfterMs('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
		expect(retryAfterMs('soon', now)).toBeNull();
		expect(retryAfterMs(null, now)).toBeNull();
	});
});
