import { cryptoRandom, createAuthKit, memoryStore, randomSecret } from '@absence0760/auth-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, main } from './operator.ts';

const kit = () => createAuthKit({ store: memoryStore(), codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 's1', secret: randomSecret(cryptoRandom) }] });

describe('the operator commands', () => {
	afterEach(() => vi.restoreAllMocks());

	it('take no address as an argument, and need the table and secret from tools/', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await main(['first-admin', 'someone@example.test'], {})).toBe(2);
		expect(await main(['nope'], {})).toBe(2);
		expect(await main([], {})).toBe(2);
		expect(await main(['first-admin'], {})).toBe(2);
		expect(err.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('someone@');
	});

	it('first-admin bootstraps once, and refuses a second', async () => {
		const auth = kit();
		expect(await COMMANDS['first-admin'].run(auth, 'Admin@Example.test')).toMatch(/^admin@example\.test is the first admin/);
		expect(await COMMANDS['first-admin'].run(auth, 'other@example.test')).toMatchObject({ ok: false, status: 409 });
	});

	it('recover-admin makes a listed user an admin, and refuses an unlisted one', async () => {
		const auth = kit();
		await auth.bootstrapAdmin('admin@example.test');
		const admin = (await auth.deps.store.getUserByEmail('admin@example.test'))!;
		await auth.addUser(admin, 'member@example.test', false);
		expect(await COMMANDS['recover-admin'].run(auth, 'member@example.test')).toMatch(/is an admin/);
		expect((await auth.deps.store.getUserByEmail('member@example.test'))!.isAdmin).toBe(true);
		expect(await COMMANDS['recover-admin'].run(auth, 'nobody@example.test')).toMatchObject({ ok: false, status: 404 });
	});

	it('clear-lock is a known command, and stops before any AWS call when stdin is not a terminal', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await main(['clear-lock'], { EWR_USERS_TABLE: 'ewr-compliance-users', EWR_RUNTIME_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:000000000000:secret:x' })).toBe(2);
		expect(String(err.mock.calls.at(-1)?.[0])).toContain('Run it from a terminal');
	});

	it('clear-lock clears a locked member, who stays a member; an unlisted address is cleared without being listed', async () => {
		const auth = kit();
		await auth.bootstrapAdmin('admin@example.test');
		const admin = (await auth.deps.store.getUserByEmail('admin@example.test'))!;
		await auth.addUser(admin, 'member@example.test', false);
		for (const email of ['member@example.test', 'stranger@example.test']) {
			for (let i = 0; i < 5; i++) await auth.verifyCode(email, '000000');
			expect(await auth.requestCode(email)).toMatchObject({ status: 'locked' });
		}
		expect(await COMMANDS['clear-lock'].run(auth, 'member@example.test')).toMatch(/^Cleared\. .*role is unchanged/);
		expect(await auth.requestCode('member@example.test')).toMatchObject({ status: 'accepted' });
		expect(await auth.deps.store.getUserByEmail('member@example.test')).toMatchObject({ isAdmin: false });
		expect(await auth.deps.store.adminCount()).toBe(1);
		expect(await COMMANDS['clear-lock'].run(auth, 'stranger@example.test')).toMatch(/^That address is not on the list/);
		expect(await auth.requestCode('stranger@example.test')).toMatchObject({ status: 'accepted' });
		// Filtered, not the newest two: rows written in one millisecond sort by their random id.
		const cleared = (await auth.deps.store.listAudit()).filter((a) => a.action === 'clear-lock').map((a) => a.target);
		expect(cleared).toHaveLength(2);
		expect(cleared).toContain('member@example.test');
		expect(cleared.find((t) => t !== 'member@example.test')).toMatch(/^unlisted:/);
		expect(await COMMANDS['clear-lock'].run(auth, 'not an address')).toMatchObject({ ok: false, status: 400 });
	});

	it('erase-user removes the user and rewrites the audit, and refuses the last admin', async () => {
		const auth = kit();
		await auth.bootstrapAdmin('admin@example.test');
		const admin = (await auth.deps.store.getUserByEmail('admin@example.test'))!;
		await auth.addUser(admin, 'member@example.test', false);
		expect(await COMMANDS['erase-user'].run(auth, 'member@example.test')).toMatch(/^Erased: the user was removed, and 1 audit rows rewritten/);
		expect(await COMMANDS['erase-user'].run(auth, 'admin@example.test')).toMatchObject({ ok: false, status: 409 });
	});
});
