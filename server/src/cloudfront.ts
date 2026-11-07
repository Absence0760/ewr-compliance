// CloudFront signed cookies: the three (and the hash algorithm) that open every file on the site
// for 15 minutes. The distribution's default behaviour trusts only the key group whose public keys
// are var.cloudfront_public_keys (infra/site.tf); this signs a custom policy for
// https://<domain>/* with the matching private key, read from the signing-key secret.
//
// RSA-SHA256, said with the optional CloudFront-Hash-Algorithm cookie (CloudFront defaults to
// SHA-1 without it). The cookies are host-only (no Domain), Path=/, Secure, HttpOnly and
// SameSite=Strict, and expire with the policy. The viewer-request function reads only the
// policy's expiry, to send an expired session to sign-in; CloudFront checks the signature.
//
// node:crypto only: signing makes no request.
import { createPublicKey, createSign, createVerify } from 'node:crypto';

/** How long the files stay open after a sign-in or a refresh. The app refreshes well inside it. */
export const FILE_ACCESS_SECONDS = 15 * 60;

export const CLOUDFRONT_COOKIES = ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id', 'CloudFront-Hash-Algorithm'] as const;

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';

export interface Signer {
	/** The CloudFront public key's id (Key-Pair-Id). */
	keyPairId: string;
	/** The matching RSA private key, PEM. */
	privateKey: string;
}

/** The custom policy: exact JSON with no whitespace, as CloudFront rebuilds it. */
export function policy(domain: string, expires: number): string {
	return JSON.stringify({ Statement: [{ Resource: `https://${domain}/*`, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] });
}

/** CloudFront's URL-safe base64: + → -, = → _, / → ~. */
export const cloudFrontBase64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const KEY_ID = /^[A-Z0-9]{8,32}$/;

/** The Set-Cookie values that open https://<domain>/* until `expires` (epoch seconds). */
export function signedCookies(domain: string, expires: number, signer: Signer, nowSeconds: number): string[] {
	if (!DOMAIN.test(domain)) throw new Error('signedCookies: not a hostname');
	if (!KEY_ID.test(signer.keyPairId)) throw new Error('signedCookies: not a CloudFront public key id');
	const maxAge = expires - nowSeconds;
	if (!Number.isInteger(expires) || maxAge <= 0) throw new Error('signedCookies: expires must be later epoch seconds');
	const text = policy(domain, expires);
	const signature = createSign('RSA-SHA256').update(text).sign(signer.privateKey);
	const values: Record<(typeof CLOUDFRONT_COOKIES)[number], string> = {
		'CloudFront-Policy': cloudFrontBase64(Buffer.from(text)),
		'CloudFront-Signature': cloudFrontBase64(signature),
		'CloudFront-Key-Pair-Id': signer.keyPairId,
		'CloudFront-Hash-Algorithm': 'SHA256'
	};
	return CLOUDFRONT_COOKIES.map((name) => `${name}=${values[name]}; Max-Age=${maxAge}; ${ATTRIBUTES}`);
}

/** Set-Cookie values that remove the file cookies, on sign-out or a refused refresh. */
export const clearSignedCookies = (): string[] => CLOUDFRONT_COOKIES.map((name) => `${name}=; Max-Age=0; ${ATTRIBUTES}`);

/**
 * Refuses a private key that isn't the other half of `publicKey` (the PEM of the key whose id
 * signs, from Terraform). Nothing at plan time can compare them without the private key, so the
 * API does at cold start: a mismatch would sign cookies CloudFront rejects with 403. Errors name
 * the problem, never quote a key.
 */
export function assertKeyPair(privateKey: string, publicKey: string): void {
	let derived: Buffer, expected: Buffer;
	try {
		derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
	} catch {
		throw new Error('the signing-key secret does not hold a readable private key (infra/README.md, H7)');
	}
	try {
		expected = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
	} catch {
		throw new Error('CLOUDFRONT_PUBLIC_KEY is not a readable public key');
	}
	const probe = policy('key-pair.check', 1);
	const signature = createSign('RSA-SHA256').update(probe).sign(privateKey);
	if (!derived.equals(expected) || !createVerify('RSA-SHA256').update(probe).verify(publicKey, signature)) {
		throw new Error('the signing-key secret is not the private half of the signing public key: put the right key in (infra/README.md, rotating the signing key)');
	}
}
