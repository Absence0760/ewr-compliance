// Who may use the site, and who may change that. Admins add and remove users, and make or unmake
// admins. The rules are here; the database is behind Store, so tests run on a fake.

export interface User {
	email: string;
	admin: boolean;
	addedBy: string;
	addedAt: string;
}

export type Action = 'add' | 'remove' | 'make admin' | 'remove admin';

/** A change, recorded with who made it. */
export interface Entry {
	at: string;
	actor: string;
	action: Action;
	target: string;
}

/** Each change and its entry are made together, or neither is. */
export interface Store {
	get(email: string): Promise<User | null>;
	list(): Promise<User[]>;
	/** False when the address is already listed. */
	insert(user: User, entry?: Entry): Promise<boolean>;
	/** Each refuses, returning false, when it would leave no admin. */
	setAdmin(email: string, admin: boolean, entry?: Entry): Promise<boolean>;
	remove(email: string, entry?: Entry): Promise<boolean>;
}

export type Result<T = null> = { ok: true; value: T } | { ok: false; status: number; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, error: string): Result<never> => ({ ok: false, status, error });

/** One @, something either side, a dot in the domain, no spaces: a typo catcher, not a validator. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalEmail(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const email = raw.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? email : null;
}

const NOT_ADMIN = no(403, 'Only an admin can manage users.');
const LAST_ADMIN = 'The site must keep at least one admin. Make someone else an admin first.';

export async function listUsers(store: Store, actor: User): Promise<Result<User[]>> {
	if (!actor.admin) return NOT_ADMIN;
	return ok((await store.list()).sort((a, b) => a.email.localeCompare(b.email)));
}

export async function addUser(store: Store, actor: User, rawEmail: unknown, admin: unknown, now: Date): Promise<Result<User>> {
	if (!actor.admin) return NOT_ADMIN;
	const email = normalEmail(rawEmail);
	if (!email) return no(400, 'Enter a whole email address, such as name@example.com.');
	if (typeof admin !== 'boolean') return no(400, 'Say whether the new user is an admin.');
	const user: User = { email, admin, addedBy: actor.email, addedAt: now.toISOString() };
	const entry: Entry = { at: user.addedAt, actor: actor.email, action: 'add', target: admin ? `${email} (admin)` : email };
	if (!(await store.insert(user, entry))) return no(409, `${email} is already on the list.`);
	return ok(user);
}

export async function setAdmin(store: Store, actor: User, rawEmail: unknown, admin: unknown, now: Date): Promise<Result> {
	if (!actor.admin) return NOT_ADMIN;
	const email = normalEmail(rawEmail);
	if (typeof admin !== 'boolean') return no(400, 'Say whether the user is an admin.');
	if (!email || !(await store.get(email))) return no(404, 'That user is not on the list.');
	if (email === actor.email && !admin) return no(400, 'You cannot remove your own admin rights. Ask another admin.');
	const entry: Entry = { at: now.toISOString(), actor: actor.email, action: admin ? 'make admin' : 'remove admin', target: email };
	if (!(await store.setAdmin(email, admin, entry))) return no(409, LAST_ADMIN);
	return ok(null);
}

export async function removeUser(store: Store, actor: User, rawEmail: unknown, now: Date): Promise<Result> {
	if (!actor.admin) return NOT_ADMIN;
	const email = normalEmail(rawEmail);
	if (!email || !(await store.get(email))) return no(404, 'That user is not on the list.');
	if (email === actor.email) return no(400, 'You cannot remove yourself. Ask another admin.');
	if (!(await store.remove(email, { at: now.toISOString(), actor: actor.email, action: 'remove', target: email }))) return no(409, LAST_ADMIN);
	return ok(null);
}
