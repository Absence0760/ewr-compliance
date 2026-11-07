import { describe, expect, it } from 'vitest';
import { groupConfig, MAX_MEMBERS, revokeSessions, syncGroup, type GroupConfig } from './accessGroup.ts';

// A made-up token: the tests check it is sent and never comes back in a reason.
const TOKEN = 'test-token-not-a-secret';
const cfg: GroupConfig = { accountId: 'acct-1', groupId: 'group-1', token: TOKEN };
const GROUP_URL = 'https://api.cloudflare.com/client/v4/accounts/acct-1/access/groups/group-1';

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A stand-in Cloudflare API: answers each call in turn, and records what was asked. */
function api(...answers: (Response | Error)[]) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		calls.push({ url, method: init.method ?? 'GET', auth: headers.get('Authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined });
		const a = answers.shift();
		if (!a) throw new Error('unexpected call');
		if (a instanceof Error) throw a;
		return a;
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

const ok = (result: unknown = {}) => Response.json({ success: true, errors: [], messages: [], result });
const fail = (status: number, errors: unknown[]) => Response.json({ success: false, errors, messages: [], result: null }, { status });
const GROUP = { id: 'group-1', name: 'ewr-compliance-users', include: [{ email: { email: 'old@example.com' } }], exclude: [{ ip: { ip: '192.0.2.0/24' } }], require: [] };

describe('groupConfig', () => {
	it('needs all three variables', () => {
		expect(groupConfig({ CF_ACCOUNT_ID: ' acct-1 ', ACCESS_GROUP_ID: 'group-1', CF_API_TOKEN: TOKEN })).toEqual(cfg);
		expect(groupConfig({ CF_ACCOUNT_ID: 'acct-1', ACCESS_GROUP_ID: 'group-1' })).toBeNull();
		expect(groupConfig({ CF_ACCOUNT_ID: 'acct-1', CF_API_TOKEN: TOKEN, ACCESS_GROUP_ID: ' ' })).toBeNull();
		expect(groupConfig({})).toBeNull();
	});
});

describe('syncGroup', () => {
	it('is not configured without a config, and calls nothing', async () => {
		const { calls, fetchFn } = api();
		expect(await syncGroup(null, ['a@example.com'], fetchFn)).toEqual({ state: 'not configured' });
		expect(calls).toEqual([]);
	});

	it("reads the group, then replaces its include rules with one email rule per address, keeping its name and other rules", async () => {
		const { calls, fetchFn } = api(ok(GROUP), ok(GROUP));
		expect(await syncGroup(cfg, ['b@example.com', 'a@example.com', 'b@example.com'], fetchFn)).toEqual({ state: 'synced' });
		expect(calls).toEqual([
			{ url: GROUP_URL, method: 'GET', auth: `Bearer ${TOKEN}`, body: undefined },
			{
				url: GROUP_URL,
				method: 'PUT',
				auth: `Bearer ${TOKEN}`,
				body: {
					name: 'ewr-compliance-users',
					include: [{ email: { email: 'a@example.com' } }, { email: { email: 'b@example.com' } }],
					exclude: [{ ip: { ip: '192.0.2.0/24' } }],
					require: []
				}
			}
		]);
	});

	it("fails with Cloudflare's own errors and the status, never the token", async () => {
		const { fetchFn } = api(ok(GROUP), fail(403, [{ code: 10000, message: `Authentication error for ${TOKEN}` }]));
		const out = await syncGroup(cfg, ['a@example.com'], fetchFn);
		expect(out).toEqual({ state: 'failed', reason: 'the Cloudflare API answered HTTP 403: Authentication error for [token] (10000)' });
		expect(JSON.stringify(out)).not.toContain(TOKEN);
	});

	it('fails when the API cannot be reached, without the underlying error text', async () => {
		const { fetchFn } = api(new Error(`network down, Authorization: Bearer ${TOKEN}`));
		const out = await syncGroup(cfg, ['a@example.com'], fetchFn);
		expect(out).toEqual({ state: 'failed', reason: 'the Cloudflare API could not be reached' });
	});

	it('fails on an answer that is not JSON, without echoing it', async () => {
		const { fetchFn } = api(new Response(`<html>Authorization: Bearer ${TOKEN}</html>`, { status: 502 }));
		expect(await syncGroup(cfg, ['a@example.com'], fetchFn)).toEqual({ state: 'failed', reason: 'the Cloudflare API answered HTTP 502' });
	});

	it('does not replace a group it could not read', async () => {
		const { calls, fetchFn } = api(fail(404, [{ code: 12130, message: 'access.api.error.not_found' }]));
		expect(await syncGroup(cfg, ['a@example.com'], fetchFn)).toMatchObject({ state: 'failed' });
		expect(calls.map((c) => c.method)).toEqual(['GET']);
	});

	it("refuses a list past Cloudflare's limit without calling the API", async () => {
		const { calls, fetchFn } = api();
		const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `u${i}@example.com`);
		expect(await syncGroup(cfg, many, fetchFn)).toEqual({
			state: 'failed', reason: `an Access group holds at most ${MAX_MEMBERS} addresses and the list has ${MAX_MEMBERS + 1}`
		});
		expect(calls).toEqual([]);
	});
});

describe('revokeSessions', () => {
	it("asks Access to end the user's sessions", async () => {
		const { calls, fetchFn } = api(Response.json({ success: true, result: true }));
		expect(await revokeSessions(cfg, 'gone@example.com', fetchFn)).toEqual({ state: 'synced' });
		expect(calls).toEqual([{
			url: 'https://api.cloudflare.com/client/v4/accounts/acct-1/access/organizations/revoke_user',
			method: 'POST', auth: `Bearer ${TOKEN}`, body: { email: 'gone@example.com' }
		}]);
	});

	it('is not configured without a config', async () => {
		expect(await revokeSessions(null, 'gone@example.com', api().fetchFn)).toEqual({ state: 'not configured' });
	});
});
