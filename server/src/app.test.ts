// The routes, end to end over auth-kit's memory store (the same tableStore the DynamoDB store
// runs). auth-kit's own suite covers the rules against DynamoDB Local; this covers what the API
// adds: status codes, cookies, the origin and CSRF checks, timing padding and the logs.
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createAuthKit, memoryStore, randomSecret, cryptoRandom, type MemoryStore } from '@absence0760/auth-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi, NotReady, SESSION_COOKIE, type ApiDeps } from './app.ts';
import type { Signer } from './cloudfront.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import type { CodeEmail } from './mail.ts';

const DOMAIN = 'ewr.example.test';
const ORIGIN = `https://${DOMAIN}`;
const SECRET = randomSecret(cryptoRandom, 36);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SIGNER: Signer = { keyPairId: 'K2JCJMDEHXQW5F', privateKey };

let store: MemoryStore;
let now: number;
let mail: { to: string; mail: CodeEmail }[];
let logs: { event: string; fields: Record<string, unknown> }[];
let slept: number[];
let signer: () => Promise<Signer>;
let handle: (r: ApiRequest) => Promise<ApiResponse>;
let auth: ReturnType<typeof createAuthKit>;

function setup(overrides: Partial<ApiDeps> = {}) {
	const clock = { now: () => now };
	auth = createAuthKit({ store, codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 's1', secret: randomSecret(cryptoRandom) }], issuer: 'ewr-compliance', clock });
	handle = createApi({
		auth,
		domain: DOMAIN,
		originSecret: SECRET,
		signer: () => signer(),
		sendMail: async (to, m) => {
			mail.push({ to, mail: m });
		},
		log: (event, fields = {}) => logs.push({ event, fields }),
		clock,
		sleep: async (ms) => {
			slept.push(ms);
			now += ms;
		},
		...overrides
	});
}

beforeEach(async () => {
	store = memoryStore();
	now = Date.parse('2026-11-06T09:00:00Z');
	mail = [];
	logs = [];
	slept = [];
	signer = async () => SIGNER;
	setup();
	expect((await auth.bootstrapAdmin('admin@example.test')).ok).toBe(true);
});

type Init = { method?: string; body?: unknown; cookie?: string | null; headers?: Record<string, string | undefined>; query?: string };

function req(path: string, init: Init = {}): ApiRequest {
	const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
	return {
		method,
		path,
		query: new URLSearchParams(init.query ?? ''),
		headers: {
			'x-origin-secret': SECRET,
			...(method !== 'GET' ? { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } : {}),
			...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...init.headers
		},
		cookie: init.cookie ?? null,
		body: init.body === undefined ? null : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
	};
}

const call = async (path: string, init: Init = {}) => {
	const r = await handle(req(path, init));
	return { ...r, json: r.body ? JSON.parse(r.body) : null };
};

const cookieValue = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);

/** Signs in as `email` (who must be listed) and returns the Cookie header the browser would send. */
async function signIn(email: string): Promise<string> {
	await call('/api/auth/code', { body: { email } });
	const code = mail.at(-1)!.mail.text.match(/^\s+(\d{6})$/m)![1];
	const r = await call('/api/auth/verify', { body: { email, code } });
	expect(r.status).toBe(200);
	return `__Host-${SESSION_COOKIE}=${cookieValue(r.cookies, `__Host-${SESSION_COOKIE}`)}`;
}

describe('the origin secret', () => {
	it('answers a call without CloudFront\'s header with a bare 404, and logs only the reason', async () => {
		for (const secret of [undefined, 'wrong', `${SECRET}x`]) {
			const r = await call('/api/me', { headers: { 'x-origin-secret': secret } });
			expect(r.status).toBe(404);
		}
		expect(logs.map((l) => l.fields.reason)).toEqual(['missing', 'mismatch', 'mismatch']);
		expect(JSON.stringify(logs)).not.toContain(SECRET);
	});
});

describe('sign-in', () => {
	it('answers 202 for a listed and an unlisted address alike, mailing only the listed one, after the same floor', async () => {
		const listed = await call('/api/auth/code', { body: { email: 'Admin@Example.test ' } });
		const listedSlept = slept.splice(0);
		const unlisted = await call('/api/auth/code', { body: { email: 'stranger@example.test' } });
		expect(listed.status).toBe(202);
		expect(unlisted.status).toBe(202);
		expect(listed.body).toBe(unlisted.body);
		expect(listed.headers).toEqual(unlisted.headers);
		expect(mail.map((m) => m.to)).toEqual(['admin@example.test']);
		// Both padded to the floor (the fake clock doesn't move while the store works).
		expect(listedSlept).toEqual([1000]);
		expect(slept).toEqual([1000]);
	});

	it('still answers 202 when the mail fails, and logs the failure by user id', async () => {
		setup({ sendMail: async () => Promise.reject(Object.assign(new Error('admin@example.test refused'), { name: 'MessageRejected' })) });
		const r = await call('/api/auth/code', { body: { email: 'admin@example.test' } });
		expect(r.status).toBe(202);
		expect(logs.at(-1)).toMatchObject({ event: 'auth.code.send_failed', fields: { error: 'MessageRejected' } });
		expect(JSON.stringify(logs)).not.toContain('@');
	});

	it('mails a 6-digit code in plain text, naming the site', async () => {
		await call('/api/auth/code', { body: { email: 'admin@example.test' } });
		const { mail: m } = mail[0]!;
		expect(m.subject).toMatch(/^Your sign-in code for EWR Compliance Measurement: \d{6}$/);
		expect(m.text).toContain(`https://${DOMAIN}/`);
		expect(m.text).toContain('10 minutes');
	});

	it('refuses a second code within a minute with 429 and Retry-After, for listed and unlisted alike', async () => {
		for (const email of ['admin@example.test', 'stranger@example.test']) {
			await call('/api/auth/code', { body: { email } });
			const r = await call('/api/auth/code', { body: { email } });
			expect(r.status).toBe(429);
			expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0);
		}
	});

	it('refuses a malformed address with 400', async () => {
		expect((await call('/api/auth/code', { body: { email: 'not an address' } })).status).toBe(400);
	});

	it('on a right code sets the session cookie and the four file cookies, all Secure, HttpOnly, SameSite=Strict', async () => {
		await call('/api/auth/code', { body: { email: 'admin@example.test' } });
		const code = mail[0]!.mail.text.match(/^\s+(\d{6})$/m)![1];
		const r = await call('/api/auth/verify', { body: { email: 'admin@example.test', code } });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ email: 'admin@example.test', admin: true });
		expect(r.cookies.map((c) => c.split('=')[0])).toEqual(['__Host-ewr_session', 'CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id', 'CloudFront-Hash-Algorithm']);
		for (const c of r.cookies) {
			expect(c).toContain('Path=/; Secure; HttpOnly; SameSite=Strict');
			expect(c).not.toMatch(/Domain=/i);
		}
		const files = r.cookies.slice(1);
		expect(files.every((c) => c.includes('Max-Age=900;'))).toBe(true);
		const policy = Buffer.from(cookieValue(r.cookies, 'CloudFront-Policy')!.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString();
		expect(JSON.parse(policy)).toEqual({ Statement: [{ Resource: `https://${DOMAIN}/*`, Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(now / 1000) + 900 } } }] });
		const sig = Buffer.from(cookieValue(r.cookies, 'CloudFront-Signature')!.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
		expect(createVerify('RSA-SHA256').update(policy).verify(publicKey, sig)).toBe(true);
		expect(logs.find((l) => l.event === 'auth.signin')?.fields).toEqual({ user: expect.stringMatching(/^[0-9a-f-]{36}$/) });
	});

	it('refuses a wrong code with 400, and logs auth.locked by an opaque subject when the lock starts', async () => {
		await call('/api/auth/code', { body: { email: 'admin@example.test' } });
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			if (i === 3) {
				now += 61_000;
				await call('/api/auth/code', { body: { email: 'admin@example.test' } });
			}
			statuses.push((await call('/api/auth/verify', { body: { email: 'admin@example.test', code: '000000' } })).status);
		}
		expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
		expect(statuses[4]).toBe(429);
		const locked = logs.filter((l) => l.event === 'auth.locked');
		expect(locked).toHaveLength(1);
		expect(locked[0]!.fields.subject).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(JSON.stringify(logs)).not.toContain('admin@example.test');
	});

	it('answers 503 and keeps the code unspent when the signing key is not in yet', async () => {
		await call('/api/auth/code', { body: { email: 'admin@example.test' } });
		const code = mail[0]!.mail.text.match(/^\s+(\d{6})$/m)![1];
		signer = async () => Promise.reject(new NotReady('the signing-key secret has no value'));
		expect((await call('/api/auth/verify', { body: { email: 'admin@example.test', code } })).status).toBe(503);
		signer = async () => SIGNER;
		expect((await call('/api/auth/verify', { body: { email: 'admin@example.test', code } })).status).toBe(200);
	});

	it('never sets a cookie for an unlisted address, even one that asked for a code', async () => {
		await call('/api/auth/code', { body: { email: 'stranger@example.test' } });
		for (const code of ['000000', '123456']) {
			const r = await call('/api/auth/verify', { body: { email: 'stranger@example.test', code } });
			expect(r.status).toBe(400);
			expect(r.cookies).toEqual([]);
		}
	});
});

describe('sessions', () => {
	it('refresh re-reads the user and issues new file cookies, never past the session', async () => {
		const cookie = await signIn('admin@example.test');
		now += 10 * 60_000;
		const r = await call('/api/auth/refresh', { method: 'POST', body: {}, cookie });
		expect(r.status).toBe(200);
		expect(r.cookies.map((c) => c.split('=')[0])).toEqual(['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id', 'CloudFront-Hash-Algorithm']);
		// Six minutes before the 7-day session ends, the files last six minutes, not fifteen.
		now += 7 * 24 * 3600_000 - 10 * 60_000 - 6 * 60_000;
		const late = await call('/api/auth/refresh', { method: 'POST', body: {}, cookie });
		expect(late.cookies[0]).toContain('Max-Age=360;');
	});

	it('a removed user gets 401 at once, from every route, and refresh clears their cookies', async () => {
		const adminCookie = await signIn('admin@example.test');
		const added = await call('/api/users', { body: { email: 'member@example.test', admin: false }, cookie: adminCookie });
		expect(added.status).toBe(201);
		now += 61_000;
		const cookie = await signIn('member@example.test');
		expect((await call('/api/me', { cookie })).status).toBe(200);

		expect((await call(`/api/users/${added.json.id}`, { method: 'DELETE', cookie: adminCookie })).status).toBe(200);
		const me = await call('/api/me', { cookie });
		expect(me.status).toBe(401);
		expect(me.json).toEqual({ error: expect.any(String), signin: '/signin/' });
		const refresh = await call('/api/auth/refresh', { method: 'POST', body: {}, cookie });
		expect(refresh.status).toBe(401);
		expect(refresh.cookies.every((c) => c.includes('Max-Age=0;'))).toBe(true);
		expect(refresh.cookies).toHaveLength(5);
	});

	it('logout ends the session; logout-everywhere ends every one', async () => {
		const a = await signIn('admin@example.test');
		const out = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: a });
		expect(out.status).toBe(200);
		expect(out.cookies.every((c) => c.includes('Max-Age=0;'))).toBe(true);
		expect((await call('/api/me', { cookie: a })).status).toBe(401);

		now += 61_000;
		const b = await signIn('admin@example.test');
		now += 61_000;
		const c = await signIn('admin@example.test');
		now += 1;
		expect((await call('/api/auth/logout-everywhere', { method: 'POST', body: {}, cookie: c })).status).toBe(200);
		expect((await call('/api/me', { cookie: b })).status).toBe(401);
		expect((await call('/api/me', { cookie: c })).status).toBe(401);
	});

	it('answers 401 JSON, never 403, without a session, and a forged token is no session', async () => {
		for (const cookie of [null, '__Host-ewr_session=abc.def.ghi', 'ewr_session=x']) {
			for (const [path, init] of [['/api/me', {}], ['/api/users', {}], ['/api/audit', {}], ['/api/auth/refresh', { method: 'POST', body: {} }], ['/api/auth/logout-everywhere', { method: 'POST', body: {} }]] as const) {
				const r = await call(path, { ...init, cookie });
				expect(r.status, `${path} ${cookie}`).toBe(401);
				expect(r.headers['Content-Type']).toContain('application/json');
			}
		}
	});
});

describe('users', () => {
	let admin: string;
	beforeEach(async () => {
		admin = await signIn('admin@example.test');
	});

	it('lists, adds (lowercased), makes and unmakes an admin, and removes', async () => {
		const added = await call('/api/users', { body: { email: ' New.Person@Example.test', admin: false }, cookie: admin });
		expect(added.status).toBe(201);
		expect(added.json).toMatchObject({ email: 'new.person@example.test', admin: false, addedBy: 'admin@example.test' });
		const id = added.json.id;
		expect((await call(`/api/users/${id}`, { method: 'PATCH', body: { admin: true }, cookie: admin })).json).toMatchObject({ admin: true });
		expect((await call(`/api/users/${id}`, { method: 'PATCH', body: { admin: false }, cookie: admin })).json).toMatchObject({ admin: false });
		const list = await call('/api/users', { cookie: admin });
		expect(list.json.map((u: { email: string }) => u.email)).toEqual(['admin@example.test', 'new.person@example.test']);
		expect(Object.keys(list.json[0]).sort()).toEqual(['addedAt', 'addedBy', 'admin', 'email', 'id']);
		expect((await call(`/api/users/${id}`, { method: 'DELETE', cookie: admin })).json).toEqual({ removed: true });
		expect(logs.filter((l) => l.event.startsWith('users.')).map((l) => l.event)).toEqual(['users.add', 'users.set_admin', 'users.set_admin', 'users.remove']);
	});

	it('refuses an address already listed with 409 and the reason', async () => {
		const r = await call('/api/users', { body: { email: 'admin@example.test', admin: true }, cookie: admin });
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('admin@example.test is already on the list.');
	});

	it('keeps the rules: no removing or demoting yourself, always an admin', async () => {
		const self = (await call('/api/me', { cookie: admin })).json.id;
		expect((await call(`/api/users/${self}`, { method: 'DELETE', cookie: admin })).status).toBe(400);
		expect((await call(`/api/users/${self}`, { method: 'PATCH', body: { admin: false }, cookie: admin })).status).toBe(400);
	});

	it('answers a non-admin 404, never 403, on every admin route', async () => {
		const added = await call('/api/users', { body: { email: 'member@example.test', admin: false }, cookie: admin });
		now += 61_000;
		const member = await signIn('member@example.test');
		const routes: [string, Init][] = [
			['/api/users', {}],
			['/api/users', { body: { email: 'x@example.test', admin: false } }],
			[`/api/users/${added.json.id}`, { method: 'PATCH', body: { admin: true } }],
			[`/api/users/${added.json.id}`, { method: 'DELETE' }],
			['/api/audit', {}]
		];
		for (const [path, init] of routes) {
			const r = await call(path, { ...init, cookie: member });
			expect(r.status, path).toBe(404);
			expect(r.json.error).toBe('Only an admin can manage users.');
		}
		expect((await call('/api/me', { cookie: member })).json).toEqual({ id: added.json.id, email: 'member@example.test', admin: false });
	});

	it('answers an unknown or malformed id with 404', async () => {
		expect((await call('/api/users/00000000-0000-4000-8000-000000000000', { method: 'DELETE', cookie: admin })).status).toBe(404);
		expect((await call('/api/users/not-a-uuid', { method: 'DELETE', cookie: admin })).status).toBe(404);
	});

	it('lists the audit, newest first, and checks the limit', async () => {
		await call('/api/users', { body: { email: 'member@example.test', admin: false }, cookie: admin });
		const r = await call('/api/audit', { cookie: admin, query: 'limit=2' });
		expect(r.status).toBe(200);
		expect(r.json.map((a: { action: string }) => a.action)).toEqual(['add', 'signin']);
		for (const limit of ['0', '1001', 'x', '-1', '1.5']) expect((await call('/api/audit', { cookie: admin, query: `limit=${limit}` })).status).toBe(400);
	});
});

describe('requests', () => {
	let admin: string;
	beforeEach(async () => {
		admin = await signIn('admin@example.test');
	});

	it('refuses a change from another site, or with no Origin, with 400', async () => {
		for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' }, { origin: `http://${DOMAIN}` }]) {
			const r = await call('/api/users', { body: { email: 'x@example.test', admin: false }, cookie: admin, headers });
			expect(r.status).toBe(400);
			expect(r.json.error).toBe('A change must be made from this site.');
			const code = await call('/api/auth/code', { body: { email: 'admin@example.test' }, headers });
			expect(code.status).toBe(400);
		}
	});

	it('takes JSON only: 415 for a form post, 400 for bad JSON, 413 past 8 KiB', async () => {
		const form = await call('/api/auth/code', { body: 'email=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
		expect(form.status).toBe(415);
		expect((await call('/api/auth/code', { body: '{"email":' })).status).toBe(400);
		expect((await call('/api/auth/code', { body: '[1]' })).status).toBe(400);
		expect((await call('/api/auth/code', { body: { email: 'a'.repeat(9000) } })).status).toBe(413);
		expect((await call('/api/auth/code', { body: '{"email":"other@example.test"}', headers: { 'content-type': 'Application/JSON; charset=utf-8' } })).status).toBe(202);
	});

	it('sends no-store and nosniff on every answer', async () => {
		for (const r of [await call('/api/me', { cookie: admin }), await call('/api/me'), await call('/api/nope'), await call('/api/auth/code', { body: { email: 'x' } })]) {
			expect(r.headers['Cache-Control']).toBe('no-store');
			expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
		}
	});

	it('answers unknown and ambiguous paths with 404 and wrong methods with 405', async () => {
		for (const path of ['/api/nope', '/api/me/x', '/api/%61uth/code', '/api//me', '/api/Me', '/api/auth/code/x', '/other', '/api/users/a/b']) {
			expect((await call(path, { cookie: admin })).status, path).toBe(404);
		}
		expect((await call('/api/auth/code', { method: 'GET' })).status).toBe(405);
		expect((await call('/api/me', { method: 'DELETE', cookie: admin })).status).toBe(405);
	});

	it('answers 500 without detail when the store fails', async () => {
		setup({ auth: { ...auth, verifySession: async () => Promise.reject(Object.assign(new Error('item admin@example.test'), { name: 'ProvisionedThroughputExceededException' })) } });
		const r = await call('/api/me', { cookie: admin });
		expect(r.status).toBe(500);
		expect(r.body).not.toContain('admin@');
		expect(logs.at(-1)).toEqual({ event: 'api.error', fields: { error: 'ProvisionedThroughputExceededException' } });
	});
});
