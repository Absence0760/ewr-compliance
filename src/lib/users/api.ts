// The site's sign-in and user list, kept by the API (server/, behind /api/* on the hosted site) and
// changed by its admins. A copy served without it, such as `pnpm dev` or `pnpm preview`, has no
// list: /api/me answers 404 there, and the app then offers no user page.
import { resolve } from '$app/paths';

export interface Me {
	id: string;
	email: string;
	admin: boolean;
}

export interface UserRow extends Me {
	addedBy: string;
	addedAt: string;
}

/** The app's root, whatever page asks: api/ and signin/ are beside it. */
const root = () => new URL(resolve('/'), location.href);
const url = (path: string) => new URL(`api/${path}`, root());

/** The sign-in page, told to come back here afterwards (only a same-origin path is followed). */
export function signinUrl(here: Location | URL = location): string {
	const next = `${here.pathname}${here.search}${here.hash}`;
	return `${new URL('signin/', root()).href}?next=${encodeURIComponent(next)}`;
}

/**
 * Sent on every call: the edge answers a request whose file cookies have run out with 401 JSON
 * rather than a redirect to the sign-in page (infra/edge_functions.tf).
 */
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

/** The API said the session is over (401). */
export class SignedOut extends Error {
	constructor() {
		super('Your sign-in has ended. Sign in again to go on.');
		this.name = 'SignedOut';
	}
}

let onSignedOut: () => void = () => {};
/** What a 401 does: the session sends the person to sign in (session.svelte.ts). */
export function whenSignedOut(fn: () => void) {
	onSignedOut = fn;
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const res = await fetch(url(path), {
		method,
		credentials: 'same-origin',
		headers: body === undefined ? XHR : { ...XHR, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (res.status === 401) {
		onSignedOut();
		throw new SignedOut();
	}
	const data = await readJson(res);
	if (!res.ok) throw new Error(errorOf(data) ?? `The request failed: HTTP ${res.status}.`);
	return data as T;
}

const readJson = (res: Response) => (res.headers.get('Content-Type')?.includes('application/json') ? res.json().catch(() => null) : Promise.resolve(null));
const errorOf = (data: unknown) => (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : null);

const asMe = (data: unknown): Me | null => {
	const d = data as Partial<Me> | null;
	return d && typeof d.email === 'string' && typeof d.id === 'string' ? { id: d.id, email: d.email, admin: d.admin === true } : null;
};

/**
 * Who is signed in; 'signed-out' when the API answers 401; or null where the site has no user list
 * (404, a body that is not the expected JSON, or a fetch that fails).
 */
async function ask(path: string, method: string): Promise<Me | 'signed-out' | null> {
	try {
		const res = await fetch(url(path), {
			method,
			credentials: 'same-origin',
			headers: method === 'GET' ? XHR : { ...XHR, 'Content-Type': 'application/json' },
			body: method === 'GET' ? undefined : '{}'
		});
		if (res.status === 401) return 'signed-out';
		return res.ok ? asMe(await readJson(res)) : null;
	} catch {
		return null;
	}
}

export const whoAmI = () => ask('me', 'GET');
/** Re-checks the session and the list, and renews the 15-minute file cookies. */
export const refresh = () => ask('auth/refresh', 'POST');

/** Ends this session and clears its cookies. */
export async function signOut(): Promise<void> {
	await fetch(url('auth/logout'), { method: 'POST', credentials: 'same-origin', headers: { ...XHR, 'Content-Type': 'application/json' }, body: '{}' });
}

export const listUsers = () => call<UserRow[]>('users');
export const addUser = (email: string, admin: boolean) => call<UserRow>('users', 'POST', { email, admin });
export const setAdmin = (id: string, admin: boolean) => call<UserRow>(`users/${encodeURIComponent(id)}`, 'PATCH', { admin });
export const removeUser = (id: string) => call<{ removed: true }>(`users/${encodeURIComponent(id)}`, 'DELETE');
