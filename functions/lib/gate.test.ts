import { beforeEach, describe, expect, it } from 'vitest';
import { d1Store } from './d1.ts';
import { KeysUnavailable } from './access.ts';
import { config, gate } from './gate.ts';
import { testDb } from './sqlite-d1.ts';
import type { Store } from './users.ts';

const cfg = { teamDomain: 'team.cloudflareaccess.com', aud: ['aud-tag'] };
const SITE = 'https://site.example';
/** Stands in for the token check: the token is the address. */
const verify = async (token: string | null) => token;
let store: Store;

const req = (path: string, init: RequestInit & { token?: string } = {}) =>
	new Request(`${SITE}${path}`, { ...init, headers: { ...(init.token ? { 'Cf-Access-Jwt-Assertion': init.token } : {}), ...(init.headers as Record<string, string>) } });

beforeEach(async () => {
	store = d1Store(testDb());
	await store.insert({ email: 'member@example.com', admin: false, addedBy: 'setup', addedAt: '2026-11-06T00:00:00Z' });
});

describe('config', () => {
	it('reads the AUD tags as a comma-separated list', () => {
		expect(config({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'site-tag, preview-tag' })).toEqual({ teamDomain: 'team.cloudflareaccess.com', aud: ['site-tag', 'preview-tag'] });
	});

	it('is missing when either setting is', () => {
		expect(config({ ACCESS_AUD: 'site-tag' })).toBeNull();
		expect(config({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: ' , ' })).toBeNull();
	});
});

describe('the gate', () => {
	it('lets a listed user through, as themself', async () => {
		expect(await gate(req('/data/index.json', { token: 'member@example.com' }), cfg, store, verify)).toMatchObject({ email: 'member@example.com', admin: false });
	});

	it('refuses everyone when the site is not set up', async () => {
		const r = (await gate(req('/', { token: 'member@example.com' }), null, store, verify)) as Response;
		expect(r.status).toBe(503);
	});

	it('refuses a request with no good token: a page for a person, JSON for the app', async () => {
		const page = (await gate(req('/nodes/'), cfg, store, verify)) as Response;
		expect(page.status).toBe(401);
		expect(page.headers.get('Content-Type')).toContain('text/html');
		const app = (await gate(req('/data/index.json', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }), cfg, store, verify)) as Response;
		expect(app.status).toBe(401);
		expect(await app.json()).toEqual({ error: 'Your sign-in has expired or could not be checked. Reload the page to sign in again.' });
	});

	it('refuses a signed-in address that is not on the list, saying which, with the address escaped', async () => {
		const r = (await gate(req('/', { token: '<b>x</b>@example.com' }), cfg, store, verify)) as Response;
		expect(r.status).toBe(403);
		const html = await r.text();
		expect(html).toContain('&#60;b&#62;x&#60;/b&#62;@example.com is not on this site');
		expect(html).not.toContain('<b>x');
	});

	it('answers JSON under api/', async () => {
		const r = (await gate(req('/api/me', { token: 'stranger@example.com' }), cfg, store, verify)) as Response;
		expect(r.status).toBe(403);
		expect(r.headers.get('Content-Type')).toBe('application/json');
	});

	it("says so when Access's keys cannot be fetched, and lets nobody in", async () => {
		const down = async () => {
			throw new KeysUnavailable('Access keys: HTTP 500');
		};
		const r = (await gate(req('/', { token: 'member@example.com' }), cfg, store, down)) as Response;
		expect(r.status).toBe(503);
		expect(await r.text()).toContain('Try again in a minute');
	});

	it('refuses a change sent from another site', async () => {
		const post = (origin?: string) => req('/api/users', { method: 'POST', token: 'member@example.com', headers: origin ? { Origin: origin } : {} });
		expect(((await gate(post('https://evil.example'), cfg, store, verify)) as Response).status).toBe(403);
		expect(((await gate(post(), cfg, store, verify)) as Response).status).toBe(403);
		expect(await gate(post(SITE), cfg, store, verify)).toMatchObject({ email: 'member@example.com' });
	});
});
