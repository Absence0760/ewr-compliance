// Keeps the Cloudflare Access group that the site's Access policy includes in step with the user list
// in D1. D1 is the source of truth and the middleware still checks it on every request; the group only
// stops Access from sending a sign-in code to anyone who is not listed. Cloudflare API, account scope:
//   GET  /accounts/{account_id}/access/groups/{group_id}             read the group, to keep its name and rules
//   PUT  /accounts/{account_id}/access/groups/{group_id}             replace it: { name, include, exclude, require }
//   POST /accounts/{account_id}/access/organizations/revoke_user     end a removed user's Access sessions
// The token needs "Access: Organizations, Identity Providers, and Groups Write" on that one account.
// Neither the token nor a response body is ever logged or put in a reason: a reason is built from the
// HTTP status and Cloudflare's error codes and messages, with the token scrubbed out in case.

export interface GroupEnv {
	CF_ACCOUNT_ID?: string;
	ACCESS_GROUP_ID?: string;
	/** A Pages secret, set by the operator. */
	CF_API_TOKEN?: string;
}

export interface GroupConfig {
	accountId: string;
	groupId: string;
	token: string;
}

/** Cloudflare's limit on the rules in one Access group (developers.cloudflare.com/cloudflare-one/account-limits/). */
export const MAX_MEMBERS = 1000;

export type SyncOutcome = { state: 'synced' } | { state: 'not configured' } | { state: 'failed'; reason: string };

export const NOT_CONFIGURED: SyncOutcome = { state: 'not configured' };

/** Null, so not configured, unless all three are set. */
export function groupConfig(env: GroupEnv): GroupConfig | null {
	const accountId = env.CF_ACCOUNT_ID?.trim();
	const groupId = env.ACCESS_GROUP_ID?.trim();
	const token = env.CF_API_TOKEN?.trim();
	return accountId && groupId && token ? { accountId, groupId, token } : null;
}

type Fetch = typeof fetch;

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope {
	success?: boolean;
	errors?: { code?: unknown; message?: unknown }[];
	result?: unknown;
}

interface Group {
	name?: unknown;
	include?: unknown;
	exclude?: unknown;
	require?: unknown;
}

class ApiError extends Error {}

/** One call. Throws ApiError with a reason safe to show: no token, no headers, no raw body. */
async function call(cfg: GroupConfig, fetchFn: Fetch, method: string, path: string, body?: unknown): Promise<Envelope> {
	let res: Response;
	try {
		res = await fetchFn(`${API}/accounts/${encodeURIComponent(cfg.accountId)}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch {
		throw new ApiError('the Cloudflare API could not be reached');
	}
	let data: Envelope | null = null;
	try {
		data = (await res.json()) as Envelope;
	} catch {
		data = null;
	}
	if (res.ok && data?.success === true) return data;
	const errors = (data?.errors ?? [])
		.map((e) => [typeof e.code === 'number' ? e.code : null, typeof e.message === 'string' ? e.message : null] as const)
		.filter(([, m]) => m)
		.map(([c, m]) => (c === null ? m! : `${m} (${c})`))
		.join('; ')
		.slice(0, 300);
	throw new ApiError(`the Cloudflare API answered HTTP ${res.status}${errors ? `: ${errors}` : ''}`);
}

const scrub = (reason: string, cfg: GroupConfig) => reason.split(cfg.token).join('[token]');

async function attempt(cfg: GroupConfig, work: () => Promise<void>): Promise<SyncOutcome> {
	try {
		await work();
		return { state: 'synced' };
	} catch (e) {
		if (!(e instanceof ApiError)) throw e;
		return { state: 'failed', reason: scrub(e.message, cfg) };
	}
}

/**
 * Makes the group include exactly these addresses, one email rule each, keeping its name and its
 * exclude and require rules. Refuses, without calling the API, a list past Cloudflare's limit.
 */
export async function syncGroup(cfg: GroupConfig | null, emails: string[], fetchFn: Fetch = fetch): Promise<SyncOutcome> {
	if (!cfg) return NOT_CONFIGURED;
	const unique = [...new Set(emails)].sort();
	if (unique.length > MAX_MEMBERS) {
		return { state: 'failed', reason: `an Access group holds at most ${MAX_MEMBERS} addresses and the list has ${unique.length}` };
	}
	if (!unique.length) return { state: 'failed', reason: 'the list is empty, and an Access group must include someone' };
	const path = `access/groups/${encodeURIComponent(cfg.groupId)}`;
	return attempt(cfg, async () => {
		const group = ((await call(cfg, fetchFn, 'GET', path)).result ?? {}) as Group;
		if (typeof group.name !== 'string' || !group.name) throw new ApiError('the Access group has no name in the Cloudflare API answer');
		await call(cfg, fetchFn, 'PUT', path, {
			name: group.name,
			include: unique.map((email) => ({ email: { email } })),
			...(Array.isArray(group.exclude) ? { exclude: group.exclude } : {}),
			...(Array.isArray(group.require) ? { require: group.require } : {})
		});
	});
}

/** Ends the Access sessions a removed user already holds, across the account's applications. */
export async function revokeSessions(cfg: GroupConfig | null, email: string, fetchFn: Fetch = fetch): Promise<SyncOutcome> {
	if (!cfg) return NOT_CONFIGURED;
	return attempt(cfg, async () => {
		await call(cfg, fetchFn, 'POST', 'access/organizations/revoke_user', { email });
	});
}
