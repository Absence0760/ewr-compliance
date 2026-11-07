import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestDelete, onRequestPatch } from '../api/users/[email].ts';
import type { SyncOutcome } from './accessGroup.ts';
import { d1Store } from './d1.ts';
import { accessStatus, addMember, removeMember, syncNow, type Access } from './membership.ts';
import { testDb } from './sqlite-d1.ts';
import type { Store, User } from './users.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
let store: Store, admin: User, member: User;

/** A stand-in for Cloudflare Access, recording what it was asked. */
function fakeAccess(configured = true, outcome: SyncOutcome = { state: 'synced' }, revoked: SyncOutcome = { state: 'synced' }) {
	const synced: string[][] = [];
	const revokedFor: string[] = [];
	const access: Access = {
		configured,
		sync: async (emails) => (synced.push(emails), outcome),
		revoke: async (email) => (revokedFor.push(email), revoked)
	};
	return { access, synced, revokedFor };
}

async function seed(email: string, isAdmin: boolean): Promise<User> {
	const u = { email, admin: isAdmin, addedBy: 'setup', addedAt: NOW.toISOString() };
	await store.insert(u);
	return u;
}

beforeEach(async () => {
	store = d1Store(testDb());
	admin = await seed('admin@example.com', true);
	member = await seed('member@example.com', false);
});

describe('adding a user', () => {
	it('syncs the whole list after the change', async () => {
		const f = fakeAccess();
		const r = await addMember(store, f.access, admin, 'New@Example.com', false, NOW);
		expect(r).toMatchObject({ ok: true, value: { email: 'new@example.com', access: { state: 'synced' } } });
		expect(f.synced.map((e) => [...e].sort())).toEqual([['admin@example.com', 'member@example.com', 'new@example.com']]);
	});

	it('keeps the change and carries the reason when the sync fails', async () => {
		const f = fakeAccess(true, { state: 'failed', reason: 'the Cloudflare API answered HTTP 500' });
		const r = await addMember(store, f.access, admin, 'new@example.com', false, NOW);
		expect(r).toMatchObject({ ok: true, value: { access: { state: 'failed', reason: 'the Cloudflare API answered HTTP 500' } } });
		expect(await store.get('new@example.com')).not.toBeNull();
	});

	it('saves the change when Access is not configured, and says so', async () => {
		const f = fakeAccess(false);
		expect(await addMember(store, f.access, admin, 'new@example.com', false, NOW)).toMatchObject({ ok: true, value: { access: { state: 'not configured' } } });
		expect(f.synced).toEqual([]);
	});

	it('does not sync a change that was refused', async () => {
		const f = fakeAccess();
		expect(await addMember(store, f.access, admin, member.email, false, NOW)).toMatchObject({ ok: false, status: 409 });
		expect(await addMember(store, f.access, member, 'x@example.com', false, NOW)).toMatchObject({ ok: false, status: 403 });
		expect(f.synced).toEqual([]);
	});

	it('refuses a user past what an Access group holds', async () => {
		const full: Store = { ...store, list: async () => Array.from({ length: 1000 }, (_, i) => ({ ...member, email: `u${i}@example.com` })) };
		const f = fakeAccess();
		expect(await addMember(full, f.access, admin, 'new@example.com', false, NOW)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('at most 1000') });
		expect(await store.get('new@example.com')).toBeNull();
	});
});

describe('removing a user', () => {
	it('syncs the list, then ends their Access sessions', async () => {
		const f = fakeAccess();
		expect(await removeMember(store, f.access, admin, ' Member@example.com', NOW)).toEqual({
			ok: true, value: { access: { state: 'synced' }, sessions: { state: 'synced' } }
		});
		expect(f.synced).toEqual([['admin@example.com']]);
		expect(f.revokedFor).toEqual(['member@example.com']);
	});

	it('keeps the removal, and leaves the sessions, when the sync fails', async () => {
		const f = fakeAccess(true, { state: 'failed', reason: 'the Cloudflare API could not be reached' });
		expect(await removeMember(store, f.access, admin, member.email, NOW)).toEqual({
			ok: true, value: { access: { state: 'failed', reason: 'the Cloudflare API could not be reached' }, sessions: null }
		});
		expect(await store.get(member.email)).toBeNull();
		expect(f.revokedFor).toEqual([]);
	});

	it('reports sessions that could not be ended', async () => {
		const f = fakeAccess(true, { state: 'synced' }, { state: 'failed', reason: 'the Cloudflare API answered HTTP 403' });
		expect(await removeMember(store, f.access, admin, member.email, NOW)).toMatchObject({
			ok: true, value: { access: { state: 'synced' }, sessions: { state: 'failed' } }
		});
	});

	it('does not sync a removal that was refused', async () => {
		const f = fakeAccess();
		expect(await removeMember(store, f.access, admin, admin.email, NOW)).toMatchObject({ ok: false, status: 400 });
		expect(f.synced).toEqual([]);
		expect(f.revokedFor).toEqual([]);
	});
});

describe('the api/users routes', () => {
	const env = { CF_ACCOUNT_ID: 'acct-1', ACCESS_GROUP_ID: 'group-1', CF_API_TOKEN: 'test-token-not-a-secret' };
	let asked: string[];
	beforeEach(() => {
		asked = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			asked.push(`${init.method} ${new URL(url).pathname.replace(/^.*\/accounts\/acct-1\//, '')}`);
			return Response.json({ success: true, result: { name: 'ewr-compliance-users' } });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	const ctx = (method: string, email: string, body?: unknown) =>
		({
			request: new Request(`https://site.example/api/users/${encodeURIComponent(email)}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
			params: { email: encodeURIComponent(email) },
			env,
			data: { user: admin, store }
		}) as unknown as Parameters<typeof onRequestPatch>[0];

	it('leave Access alone when an admin is made or unmade', async () => {
		expect((await onRequestPatch(ctx('PATCH', member.email, { admin: true }))).status).toBe(200);
		expect((await onRequestPatch(ctx('PATCH', member.email, { admin: false }))).status).toBe(200);
		expect(asked).toEqual([]);
	});

	it('sync the group and end the sessions when a user is removed', async () => {
		const res = await onRequestDelete(ctx('DELETE', member.email));
		expect(await res.json()).toEqual({ access: { state: 'synced' }, sessions: { state: 'synced' } });
		expect(asked).toEqual(['GET access/groups/group-1', 'PUT access/groups/group-1', 'POST access/organizations/revoke_user']);
	});
});

describe('syncing on demand', () => {
	it('syncs the whole list for an admin', async () => {
		const f = fakeAccess();
		expect(await syncNow(store, f.access, admin)).toEqual({ ok: true, value: { access: { state: 'synced' }, count: 2 } });
		expect(f.synced.map((e) => [...e].sort())).toEqual([['admin@example.com', 'member@example.com']]);
	});

	it('is not configured without the settings', async () => {
		expect(await syncNow(store, fakeAccess(false).access, admin)).toEqual({ ok: true, value: { access: { state: 'not configured' }, count: 2 } });
	});

	it('is for admins only, as is the status', async () => {
		const f = fakeAccess();
		expect(await syncNow(store, f.access, member)).toMatchObject({ ok: false, status: 403 });
		expect(accessStatus(f.access, member)).toMatchObject({ ok: false, status: 403 });
		expect(accessStatus(f.access, admin)).toEqual({ ok: true, value: { configured: true } });
		expect(f.synced).toEqual([]);
	});
});
