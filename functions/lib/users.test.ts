import { beforeEach, describe, expect, it } from 'vitest';
import { d1Store } from './d1.ts';
import { auditRows, testDb } from './sqlite-d1.ts';
import { addUser, listUsers, normalEmail, removeUser, setAdmin, type Store, type User } from './users.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
let d1: ReturnType<typeof testDb>, store: Store, admin: User, member: User;

async function seed(email: string, isAdmin: boolean): Promise<User> {
	const u = { email, admin: isAdmin, addedBy: 'setup', addedAt: NOW.toISOString() };
	await store.insert(u);
	return u;
}

beforeEach(async () => {
	d1 = testDb();
	store = d1Store(d1);
	admin = await seed('admin@example.com', true);
	member = await seed('member@example.com', false);
});

describe('normalEmail', () => {
	it('trims and lowercases', () => expect(normalEmail('  New.Person@Example.COM ')).toBe('new.person@example.com'));
	it.each(['', 'no-at.example.com', 'a@b', 'two words@example.com', 42, null])('refuses %j', (e) => expect(normalEmail(e)).toBeNull());
});

describe('an admin', () => {
	it('lists users by address', async () => {
		const r = await listUsers(store, admin);
		expect(r.ok && r.value.map((u) => [u.email, u.admin])).toEqual([['admin@example.com', true], ['member@example.com', false]]);
	});

	it('adds a user, or another admin, and the change is logged', async () => {
		expect(await addUser(store, admin, ' New@Example.com', false, NOW)).toEqual({
			ok: true, value: { email: 'new@example.com', admin: false, addedBy: 'admin@example.com', addedAt: NOW.toISOString() }
		});
		expect((await addUser(store, admin, 'boss@example.com', true, NOW)).ok).toBe(true);
		expect((await store.get('boss@example.com'))?.admin).toBe(true);
		expect(auditRows(d1)).toEqual([
			{ actor: 'admin@example.com', action: 'add', target: 'new@example.com' },
			{ actor: 'admin@example.com', action: 'add', target: 'boss@example.com (admin)' }
		]);
	});

	it('cannot add an address twice, whatever its case', async () => {
		expect(await addUser(store, admin, 'MEMBER@example.com', false, NOW)).toEqual({ ok: false, status: 409, error: 'member@example.com is already on the list.' });
	});

	it('must give a whole address and say whether it is an admin', async () => {
		expect(await addUser(store, admin, 'member', false, NOW)).toMatchObject({ ok: false, status: 400 });
		expect(await addUser(store, admin, 'x@example.com', 'yes', NOW)).toMatchObject({ ok: false, status: 400 });
	});

	it('makes a user an admin, and back', async () => {
		expect((await setAdmin(store, admin, member.email, true, NOW)).ok).toBe(true);
		expect((await store.get(member.email))?.admin).toBe(true);
		expect((await setAdmin(store, admin, member.email, false, NOW)).ok).toBe(true);
		expect((await store.get(member.email))?.admin).toBe(false);
		expect(auditRows(d1).map((r) => r.action)).toEqual(['make admin', 'remove admin']);
	});

	it('removes a user, who is then gone', async () => {
		expect((await removeUser(store, admin, member.email, NOW)).ok).toBe(true);
		expect(await store.get(member.email)).toBeNull();
		expect(auditRows(d1)).toEqual([{ actor: 'admin@example.com', action: 'remove', target: 'member@example.com' }]);
	});

	it('cannot remove themself or their own admin rights', async () => {
		expect(await removeUser(store, admin, admin.email, NOW)).toMatchObject({ ok: false, status: 400 });
		expect(await setAdmin(store, admin, admin.email, false, NOW)).toMatchObject({ ok: false, status: 400 });
		expect((await store.get(admin.email))?.admin).toBe(true);
	});

	it('is told when the user is not on the list', async () => {
		expect(await removeUser(store, admin, 'gone@example.com', NOW)).toMatchObject({ ok: false, status: 404 });
		expect(await setAdmin(store, admin, 'gone@example.com', true, NOW)).toMatchObject({ ok: false, status: 404 });
	});
});

describe('a user who is not an admin', () => {
	it('can neither see nor change the list', async () => {
		const refused = { ok: false, status: 403, error: 'Only an admin can manage users.' };
		expect(await listUsers(store, member)).toEqual(refused);
		expect(await addUser(store, member, 'x@example.com', false, NOW)).toEqual(refused);
		expect(await setAdmin(store, member, member.email, true, NOW)).toEqual(refused);
		expect(await removeUser(store, member, admin.email, NOW)).toEqual(refused);
		expect(auditRows(d1)).toEqual([]);
	});
});

describe('the last admin', () => {
	// Two admins each removing the other at once: the database's own check keeps one.
	it('cannot be removed or unmade by the store, whatever the rules saw', async () => {
		await seed('second@example.com', true);
		expect(await store.remove('second@example.com')).toBe(true);
		expect(await store.remove(admin.email)).toBe(false);
		expect(await store.setAdmin(admin.email, false)).toBe(false);
		expect((await store.get(admin.email))?.admin).toBe(true);
	});

	it('is refused with a reason when another admin acts on stale information', async () => {
		const second = await seed('second@example.com', true);
		await store.remove(admin.email);
		// second still believes admin@ is an admin, and so is not the last; the store says otherwise.
		expect(await removeUser(store, { ...admin, email: 'ghost@example.com' }, second.email, NOW)).toMatchObject({ ok: false, status: 409 });
	});

	it('leaves members free to be removed', async () => {
		expect(await store.remove(member.email)).toBe(true);
	});
});

describe('the record of changes', () => {
	it('is kept with the change: when the record cannot be written, nothing changes', async () => {
		d1.raw.exec('DROP TABLE audit');
		await expect(addUser(store, admin, 'new@example.com', false, NOW)).rejects.toThrow();
		await expect(removeUser(store, admin, member.email, NOW)).rejects.toThrow();
		expect(await store.get('new@example.com')).toBeNull();
		expect(await store.get(member.email)).not.toBeNull();
	});

	it('records nothing for a change that did not happen', async () => {
		await addUser(store, admin, member.email, false, NOW);
		expect(auditRows(d1)).toEqual([]);
	});
});

describe('the table', () => {
	it('refuses an address typed in by hand that is not lowercase and trimmed', () => {
		const add = (email: string) => d1.raw.prepare("INSERT INTO users (email, admin, added_by, added_at) VALUES (?, 1, 'operator', datetime('now'))").run(email);
		expect(() => add('First.Admin@example.com')).toThrow(/CHECK constraint/);
		expect(() => add(' first@example.com')).toThrow(/CHECK constraint/);
		expect(() => add('nobody')).toThrow(/CHECK constraint/);
		expect(() => add('first.admin@example.com')).not.toThrow();
	});
});

