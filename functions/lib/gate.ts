// The check in front of every file and request: a verified Access token for an address on the list.
// Access proves who someone is; the list, kept by the site's admins, decides whether they may come in.
import { KeysUnavailable, verifiedEmail, type AccessConfig } from './access.ts';
import type { Store, User } from './users.ts';

export interface Env {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	USERS_DB?: D1Database;
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page, for a person who opened the site in a browser. */
function page(status: number, title: string, text: string) {
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><body style="font:16px system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 1em"><h1 style="font-size:1.4em">${escape(title)}</h1><p>${escape(text)}</p></body></html>`;
	return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** The app's own requests ask for JSON, and so does anything under api/. */
const wantsJson = (req: Request) => req.headers.get('X-Requested-With') === 'XMLHttpRequest' || new URL(req.url).pathname.startsWith('/api/');

function refuse(req: Request, status: number, title: string, text: string) {
	return wantsJson(req) ? json({ error: text }, status) : page(status, title, text);
}

/** Reads and writes are fine from anywhere signed in; a change must come from the site's own pages. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A Response to send instead, or the user to go on with. */
export async function gate(
	req: Request,
	cfg: AccessConfig | null,
	store: Store | null,
	verify: (token: string | null, cfg: AccessConfig) => Promise<string | null> = verifiedEmail
): Promise<Response | User> {
	if (!cfg || !store) return refuse(req, 503, 'Not set up', 'This site is not set up yet: its sign-in settings or user list are missing.');
	let email: string | null;
	try {
		email = await verify(req.headers.get('Cf-Access-Jwt-Assertion'), cfg);
	} catch (e) {
		if (!(e instanceof KeysUnavailable)) throw e;
		return refuse(req, 503, 'Sign-in unavailable', 'Your sign-in could not be checked just now, because Cloudflare Access did not answer. Try again in a minute.');
	}
	if (!email) return refuse(req, 401, 'Sign-in needed', 'Your sign-in has expired or could not be checked. Reload the page to sign in again.');
	const user = await store.get(email);
	if (!user) {
		return refuse(req, 403, 'Not on the list', `${email} is not on this site's list of users. Ask one of its admins to add you, then reload.`);
	}
	if (!SAFE.has(req.method) && req.headers.get('Origin') !== new URL(req.url).origin) {
		return refuse(req, 403, 'Refused', 'A change must be made from this site.');
	}
	return user;
}

/** ACCESS_AUD lists the applications' AUD tags, separated by commas. */
export function config(env: Env): AccessConfig | null {
	const aud = (env.ACCESS_AUD ?? '').split(',').map((a) => a.trim()).filter(Boolean);
	return env.ACCESS_TEAM_DOMAIN && aud.length ? { teamDomain: env.ACCESS_TEAM_DOMAIN.trim(), aud } : null;
}
