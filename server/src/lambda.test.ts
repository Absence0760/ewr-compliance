import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler, recordAudit, toRequest, toResult } from './lambda.ts';

describe('the Function URL event', () => {
	it('becomes a request: lowercase headers, the cookies joined, a base64 body decoded', () => {
		const r = toRequest({
			rawPath: '/api/auth/verify',
			rawQueryString: 'limit=5',
			headers: { 'Content-Type': 'application/json', Origin: 'https://ewr.example.test' },
			cookies: ['a=1', '__Host-ewr_session=t'],
			body: Buffer.from('{"code":"123456"}').toString('base64'),
			isBase64Encoded: true,
			requestContext: { http: { method: 'post' } }
		});
		expect(r).toMatchObject({ method: 'POST', path: '/api/auth/verify', cookie: 'a=1; __Host-ewr_session=t', body: '{"code":"123456"}' });
		expect(r.headers['content-type']).toBe('application/json');
		expect(r.query.get('limit')).toBe('5');
	});

	it('answers with the cookies as Set-Cookie values', () => {
		expect(toResult({ status: 200, headers: { a: 'b' }, cookies: ['x=1'], body: '{}' })).toEqual({ statusCode: 200, headers: { a: 'b' }, cookies: ['x=1'], body: '{}' });
	});
});

describe('the node store’s audit seam', () => {
	it('records each node-store change as auth-kit app action, the admin as actor', async () => {
		const actor = { id: 'u', email: 'admin@example.test', isAdmin: true, addedBy: 'operator', addedAt: '', sessionsRevokedAt: null, undeliverable: null };
		const recordAppAction = vi.fn(async () => ({ ok: true as const, value: {} }));
		await expect(recordAudit({ recordAppAction } as never)(actor, 'node.put', 'vaal-orange vaal-orange:syx1')).resolves.toEqual({ ok: true, value: {} });
		expect(recordAppAction).toHaveBeenCalledWith(actor, 'node.put', 'vaal-orange vaal-orange:syx1');
	});
});

describe('the handler', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('fails closed with 503 when it is not configured, logging the setting, never a value', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.stubEnv('USERS_TABLE', '');
		const r = await handler({ rawPath: '/api/me', requestContext: { http: { method: 'GET' } } });
		expect(r.statusCode).toBe(503);
		expect(r.headers['Cache-Control']).toBe('no-store');
		expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: 'api.not_ready', reason: 'USERS_TABLE is missing or malformed' });
		log.mockRestore();
	});
});
