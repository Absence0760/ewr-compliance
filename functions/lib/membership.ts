// A change to who is on the list, then the Access group brought in step with it. The list in D1 is the
// source of truth: when the group cannot be updated, the change stands, the middleware still enforces
// it, and the reply carries the reason so an admin can sync again. Making or unmaking an admin does not
// change who is on the list, so it does not touch the group (users.ts setAdmin, unchanged).
import { MAX_MEMBERS, NOT_CONFIGURED, revokeSessions, syncGroup, type GroupConfig, type SyncOutcome } from './accessGroup.ts';
import { addUser, normalEmail, removeUser, type Result, type Store, type User } from './users.ts';

/** What a change does to Cloudflare Access. Tests stand in a fake. */
export interface Access {
	configured: boolean;
	sync(emails: string[]): Promise<SyncOutcome>;
	revoke(email: string): Promise<SyncOutcome>;
}

export function cloudflareAccess(cfg: GroupConfig | null, fetchFn: typeof fetch = fetch): Access {
	return {
		configured: cfg !== null,
		sync: (emails) => syncGroup(cfg, emails, fetchFn),
		revoke: (email) => revokeSessions(cfg, email, fetchFn)
	};
}

const NOT_ADMIN: Result<never> = { ok: false, status: 403, error: 'Only an admin can manage users.' };

const syncList = async (store: Store, access: Access) =>
	access.configured ? access.sync((await store.list()).map((u) => u.email)) : NOT_CONFIGURED;

export async function addMember(
	store: Store, access: Access, actor: User, rawEmail: unknown, admin: unknown, now: Date
): Promise<Result<User & { access: SyncOutcome }>> {
	if (actor.admin && access.configured && (await store.list()).length >= MAX_MEMBERS) {
		return { ok: false, status: 409, error: `The list is full: a Cloudflare Access group holds at most ${MAX_MEMBERS} addresses. Remove someone first.` };
	}
	const r = await addUser(store, actor, rawEmail, admin, now);
	return r.ok ? { ok: true, value: { ...r.value, access: await syncList(store, access) } } : r;
}

/**
 * The group first, so Access sends the removed user no new code, then their sessions are ended. When
 * the group could not be updated their sessions are left (null), since they could sign in again at once.
 */
export async function removeMember(
	store: Store, access: Access, actor: User, rawEmail: unknown, now: Date
): Promise<Result<{ access: SyncOutcome; sessions: SyncOutcome | null }>> {
	const r = await removeUser(store, actor, rawEmail, now);
	if (!r.ok) return r;
	const synced = await syncList(store, access);
	// removeUser has already refused an address normalEmail does not take.
	const sessions = synced.state === 'synced' ? await access.revoke(normalEmail(rawEmail)!) : null;
	return { ok: true, value: { access: synced, sessions } };
}

/** Whether the site keeps the group in step, for the Users page. */
export const accessStatus = (access: Access, actor: User): Result<{ configured: boolean }> =>
	actor.admin ? { ok: true, value: { configured: access.configured } } : NOT_ADMIN;

/** The whole list again, on demand. */
export async function syncNow(store: Store, access: Access, actor: User): Promise<Result<{ access: SyncOutcome; count: number }>> {
	if (!actor.admin) return NOT_ADMIN;
	const emails = (await store.list()).map((u) => u.email);
	return { ok: true, value: { access: access.configured ? await access.sync(emails) : NOT_CONFIGURED, count: emails.length } };
}
