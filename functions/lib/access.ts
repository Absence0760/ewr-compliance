// Checks the token Cloudflare Access puts on every request it lets through, so the site never trusts a
// header it did not verify. Pure: the key fetch and the clock are passed in, so tests can supply both.

export interface AccessConfig {
	/** The Zero Trust team domain, as `<team>.cloudflareaccess.com`. */
	teamDomain: string;
	/** The Application Audience (AUD) tags of the site's Access applications: the site, and its deployment previews. */
	aud: string[];
}

interface Jwk extends JsonWebKey {
	kid: string;
}

type FetchKeys = (url: string) => Promise<Jwk[]>;

/** Access rotates its keys every six weeks or so, and an unknown key id fetches them again. */
const KEY_TTL_MS = 60 * 60 * 1000;
/** But not more often than this, so tokens with made-up key ids cannot force a fetch on every request. */
const REFETCH_FLOOR_MS = 60 * 1000;

/** Access's keys could not be fetched, so no token can be checked: not the same as a bad token. */
export class KeysUnavailable extends Error {}
let cached: { url: string; at: number; keys: Jwk[] } | null = null;

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

export const certsUrl = (teamDomain: string) => `https://${teamDomain}/cdn-cgi/access/certs`;

export const fetchKeys: FetchKeys = async (url) => {
	const res = await fetch(url);
	if (!res.ok) throw new KeysUnavailable(`Access keys: HTTP ${res.status}`);
	const keys = ((await res.json()) as { keys?: unknown }).keys;
	if (!Array.isArray(keys)) throw new KeysUnavailable('Access keys: no key list');
	return keys as Jwk[];
};

async function keyFor(kid: string, url: string, now: number, get: FetchKeys): Promise<Jwk | undefined> {
	const mine = cached && cached.url === url ? cached : null;
	const key = mine && now - mine.at < KEY_TTL_MS ? mine.keys.find((k) => k.kid === kid) : undefined;
	if (key || (mine && now - mine.at < REFETCH_FLOOR_MS)) return key;
	try {
		cached = { url, at: now, keys: await get(url) };
	} catch (e) {
		throw e instanceof KeysUnavailable ? e : new KeysUnavailable(`Access keys: ${(e as Error).message}`);
	}
	return cached.keys.find((k) => k.kid === kid);
}

/** Forget the cached keys. For tests. */
export const forgetKeys = () => (cached = null);

type Claims = { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };

/** The token's parts, or null for anything malformed: bad base64, JSON that is not an object. */
function parse(token: string): { header: { alg?: unknown; kid?: unknown }; claims: Claims; signed: Uint8Array; sig: Uint8Array } | null {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	try {
		const header = json(parts[0]), claims = json(parts[1]);
		if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return null;
		return { header, claims, signed: new TextEncoder().encode(`${parts[0]}.${parts[1]}`), sig: fromB64url(parts[2]) };
	} catch {
		return null;
	}
}

async function signatureHolds(jwk: Jwk, sig: Uint8Array, signed: Uint8Array): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
	} catch {
		return false;
	}
}

/**
 * The email address the token was issued to, lowercased, or null when the token is missing, malformed,
 * signed by another key, for another application or team, or out of date. Throws KeysUnavailable when
 * Access's keys cannot be fetched.
 */
export async function verifiedEmail(token: string | null, cfg: AccessConfig, now = Date.now(), get: FetchKeys = fetchKeys): Promise<string | null> {
	const t = token ? parse(token) : null;
	if (!t || t.header.alg !== 'RS256' || typeof t.header.kid !== 'string' || !t.header.kid) return null;
	const jwk = await keyFor(t.header.kid, certsUrl(cfg.teamDomain), now, get);
	if (!jwk || !(await signatureHolds(jwk, t.sig, t.signed))) return null;
	const claims = t.claims;
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	const secs = now / 1000;
	if (!auds.some((a) => typeof a === 'string' && cfg.aud.includes(a)) || claims.iss !== `https://${cfg.teamDomain}`) return null;
	if (typeof claims.exp !== 'number' || claims.exp <= secs || (typeof claims.nbf === 'number' && claims.nbf > secs)) return null;
	return typeof claims.email === 'string' && claims.email ? claims.email.trim().toLowerCase() : null;
}
