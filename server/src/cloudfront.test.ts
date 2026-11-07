import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertKeyPair, clearSignedCookies, cloudFrontBase64, policy, signedCookies } from './cloudfront.ts';

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const a = pair();
const b = pair();
const SIGNER = { keyPairId: 'K2JCJMDEHXQW5F', privateKey: a.privateKey };

describe('signed cookies', () => {
	it('signs a custom policy for every path on the one host, with no whitespace', () => {
		expect(policy('ewr.example.test', 1700000900)).toBe('{"Statement":[{"Resource":"https://ewr.example.test/*","Condition":{"DateLessThan":{"AWS:EpochTime":1700000900}}}]}');
	});

	it('uses CloudFront\'s URL-safe base64', () => {
		expect(cloudFrontBase64(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-~~-');
		expect(cloudFrontBase64(Buffer.from('a'))).toBe('YQ__');
	});

	it('sets four host-only cookies that expire with the policy', () => {
		const cookies = signedCookies('ewr.example.test', 1700000900, SIGNER, 1700000000);
		expect(cookies.map((c) => c.split('=')[0])).toEqual(['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id', 'CloudFront-Hash-Algorithm']);
		for (const c of cookies) expect(c).toMatch(/; Max-Age=900; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
		expect(cookies[2]).toMatch(/^CloudFront-Key-Pair-Id=K2JCJMDEHXQW5F;/);
		expect(cookies[3]).toMatch(/^CloudFront-Hash-Algorithm=SHA256;/);
	});

	it('refuses a bad host, key id or expiry', () => {
		expect(() => signedCookies('ewr.example.test/x', 2, SIGNER, 1)).toThrow();
		expect(() => signedCookies('ewr.example.test', 2, { ...SIGNER, keyPairId: 'k*' }, 1)).toThrow();
		expect(() => signedCookies('ewr.example.test', 1, SIGNER, 1)).toThrow();
	});

	it('clears all four', () => {
		expect(clearSignedCookies().every((c) => /^CloudFront-[A-Za-z-]+=; Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Strict$/.test(c))).toBe(true);
	});
});

describe('the key pair check', () => {
	it('accepts the matching halves', () => {
		expect(() => assertKeyPair(a.privateKey, a.publicKey)).not.toThrow();
	});

	it('refuses another key, or a value that is not a key, without quoting it', () => {
		expect(() => assertKeyPair(b.privateKey, a.publicKey)).toThrow(/not the private half/);
		expect(() => assertKeyPair('not a key', a.publicKey)).toThrow(/readable private key/);
		try {
			assertKeyPair(b.privateKey, a.publicKey);
		} catch (e) {
			expect((e as Error).message).not.toContain('PRIVATE');
		}
	});
});
