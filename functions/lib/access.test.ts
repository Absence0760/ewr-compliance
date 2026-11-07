import { beforeEach, describe, expect, it } from 'vitest';
import { forgetKeys, KeysUnavailable, verifiedEmail } from './access.ts';

const cfg = { teamDomain: 'team.cloudflareaccess.com', aud: ['aud-tag', 'preview-tag'] };
const NOW = Date.UTC(2026, 10, 6, 12);
const secs = NOW / 1000;

const b64url = (b: Uint8Array | string) =>
	btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function keyPair(kid: string) {
	const k = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']
	)) as CryptoKeyPair;
	return { kid, privateKey: k.privateKey, jwk: { ...((await crypto.subtle.exportKey('jwk', k.publicKey)) as JsonWebKey), kid } };
}
const [ours, other] = await Promise.all([keyPair('k1'), keyPair('k2')]);

async function token(claims: Record<string, unknown>, key = ours, header: Record<string, unknown> = { alg: 'RS256', kid: key.kid }) {
	const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(head));
	return `${head}.${b64url(new Uint8Array(sig))}`;
}
const good = { aud: ['aud-tag'], iss: 'https://team.cloudflareaccess.com', exp: secs + 3600, nbf: secs - 60, email: 'Someone@Example.com' };

let fetched: string[];
const keys = async (url: string) => (fetched.push(url), [ours.jwk]);
const check = (t: string | null) => verifiedEmail(t, cfg, NOW, keys);

beforeEach(() => {
	forgetKeys();
	fetched = [];
});

describe('an Access token', () => {
	it('gives its email, lowercased, when signed by the team for this application', async () => {
		expect(await check(await token(good))).toBe('someone@example.com');
		expect(fetched).toEqual(['https://team.cloudflareaccess.com/cdn-cgi/access/certs']);
	});

	it('takes aud as a string as well as a list', async () => {
		expect(await check(await token({ ...good, aud: 'aud-tag' }))).toBe('someone@example.com');
	});

	it("takes either application's audience: the site's or its previews'", async () => {
		expect(await check(await token({ ...good, aud: ['preview-tag'] }))).toBe('someone@example.com');
	});

	it('fetches the keys once, not on every request', async () => {
		await check(await token(good));
		await check(await token(good));
		expect(fetched).toHaveLength(1);
	});

	it.each([
		['for another application', { aud: ['other'] }],
		['from another team', { iss: 'https://other.cloudflareaccess.com' }],
		['expired', { exp: secs - 1 }],
		['with no expiry', { exp: undefined }],
		['not valid yet', { nbf: secs + 60 }],
		['with no email', { email: undefined }]
	])('is refused when %s', async (_, change) => {
		expect(await check(await token({ ...good, ...change }))).toBeNull();
	});

	it('is refused when signed by a key the team does not hold, after looking again', async () => {
		expect(await check(await token(good, other))).toBeNull();
		expect(fetched).toHaveLength(1);
	});

	it('is refused when its claims were changed after signing', async () => {
		const [h, , s] = (await token(good)).split('.');
		expect(await check(`${h}.${b64url(JSON.stringify({ ...good, email: 'admin@example.com' }))}.${s}`)).toBeNull();
	});

	it('is refused, not an error, when any part is garbage', async () => {
		const [h, c] = (await token(good)).split('.');
		expect(await check(`${h}.${c}.not*base64`)).toBeNull();
		expect(await check(`${b64url('null')}.${c}.x`)).toBeNull();
		expect(await check(`${h}.${b64url('[1]')}.x`)).toBeNull();
		expect(await check(`${b64url('{')}.${c}.x`)).toBeNull();
	});

	it('is refused when the key Access lists cannot be used', async () => {
		const broken = async () => [{ ...ours.jwk, n: 'AA' }];
		expect(await verifiedEmail(await token(good), cfg, NOW, broken)).toBeNull();
	});

	it('is refused unsigned, malformed or missing', async () => {
		const unsigned = `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64url(JSON.stringify(good))}.`;
		expect(await check(unsigned)).toBeNull();
		expect(await check('not.a.token')).toBeNull();
		expect(await check('nodots')).toBeNull();
		expect(await check(null)).toBeNull();
	});
});

describe('the keys', () => {
	it('are fetched again for an unknown key id at most once a minute', async () => {
		const stranger = await token(good, other);
		await check(stranger);
		await check(stranger);
		expect(fetched).toHaveLength(1);
		await verifiedEmail(stranger, cfg, NOW + 61_000, keys);
		expect(fetched).toHaveLength(2);
	});

	it('are fetched again once an hour old', async () => {
		await check(await token(good));
		expect(await verifiedEmail(await token({ ...good, exp: secs + 7200 }), cfg, NOW + 3_600_000, keys)).toBe('someone@example.com');
		expect(fetched).toHaveLength(2);
	});

	it('that cannot be fetched say so, rather than calling the token bad', async () => {
		const down = async () => {
			throw new TypeError('fetch failed');
		};
		await expect(verifiedEmail(await token(good), cfg, NOW, down)).rejects.toBeInstanceOf(KeysUnavailable);
	});
});
