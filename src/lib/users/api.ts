// The site's user list, kept by the host (functions/ in the repo) and changed by its admins. A copy
// served without those functions, such as `pnpm dev`, has no list, and the app then offers no user page.
import { resolve } from '$app/paths';

export interface Me {
	email: string;
	admin: boolean;
}

export interface UserRow extends Me {
	addedBy: string;
	addedAt: string;
}

/** api/ is at the app's root, whatever page asks. */
const url = (path: string) => new URL(`api/${path}`, new URL(resolve('/'), location.href));

/** Sent on every call, so the host answers an expired sign-in with JSON and not a sign-in page. */
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const res = await fetch(url(path), {
		method,
		headers: body === undefined ? XHR : { ...XHR, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data = await readJson(res);
	if (!res.ok) throw new Error(errorOf(data) ?? `The request failed: HTTP ${res.status}.`);
	return data as T;
}

const readJson = (res: Response) => (res.headers.get('Content-Type')?.includes('application/json') ? res.json().catch(() => null) : Promise.resolve(null));
const errorOf = (data: unknown) => (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : null);

/**
 * Who is signed in; 'expired' when the host answers 401, its JSON answer for an Access sign-in that
 * has run out; or null where the site has no user list (404, a body that is not the expected JSON, or
 * a fetch that fails, which is also how Access's cross-origin redirect after expiry shows up: it cannot
 * be told apart from an unreachable host, so it is not taken for an expired sign-in).
 */
export async function whoAmI(): Promise<Me | 'expired' | null> {
	try {
		const res = await fetch(url('me'), { headers: XHR });
		if (res.status === 401) return 'expired';
		const data = res.ok ? await readJson(res) : null;
		return data && typeof data.email === 'string' ? { email: data.email, admin: data.admin === true } : null;
	} catch {
		return null;
	}
}

/**
 * What a change did to the Cloudflare Access group the host keeps in step with the list
 * (functions/lib/accessGroup.ts). The list is saved whatever this says.
 */
export type AccessSync = { state: 'synced' } | { state: 'not configured' } | { state: 'failed'; reason: string };

export const listUsers = () => call<UserRow[]>('users');
export const addUser = (email: string, admin: boolean) => call<UserRow & { access: AccessSync }>('users', 'POST', { email, admin });
export const setAdmin = (email: string, admin: boolean) => call<null>(`users/${encodeURIComponent(email)}`, 'PATCH', { admin });
/** sessions is null when the group was not updated, so their sessions were left alone. */
export const removeUser = (email: string) =>
	call<{ access: AccessSync; sessions: AccessSync | null }>(`users/${encodeURIComponent(email)}`, 'DELETE');
/** Whether the host keeps the Access group in step with the list. */
export const accessStatus = () => call<{ configured: boolean }>('users/sync');
export const syncAccess = () => call<{ access: AccessSync; count: number }>('users/sync', 'POST');
