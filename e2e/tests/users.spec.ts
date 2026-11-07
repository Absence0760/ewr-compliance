import { expect, MAP, test, USER_API } from '../support/app.ts';
import type { Page, Request } from '@playwright/test';

// A made-up API with a user list (server/ on the hosted site). It keeps the rules the page relies
// on: an address already listed is refused with a reason, users are named by id, and every call
// carries X-Requested-With. `signedIn: false` answers 401, as the API does once a session is over.
type U = { id: string; email: string; admin: boolean; addedBy: string; addedAt: string };
type Me = { id: string; email: string; admin: boolean };

async function host(page: Page, me: Me, start: U[] = [], opts: { signedIn?: () => boolean } = {}) {
	let users = structuredClone(start);
	const calls: Request[] = [];
	let next = 1;
	await page.route(USER_API, async (route) => {
		const req = route.request();
		calls.push(req);
		const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
		const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'cache-control': 'no-store' } });
		if (path === 'auth/logout') return reply({ signedOut: true });
		if (opts.signedIn && !opts.signedIn()) return reply({ error: 'You are not signed in, or your sign-in has expired.', signin: '/signin/' }, 401);
		if (path === 'me' || path === 'auth/refresh') return reply(me);
		if (!me.admin) return reply({ error: 'Only an admin can manage users.' }, 404);
		if (path === 'users' && req.method() === 'GET') return reply(users);
		if (path === 'users' && req.method() === 'POST') {
			const b = req.postDataJSON();
			const email = String(b.email).trim().toLowerCase();
			if (users.some((u) => u.email === email)) return reply({ error: `${email} is already on the list.` }, 409);
			const u = { id: `00000000-0000-4000-8000-00000000000${next++}`, email, admin: b.admin, addedBy: me.email, addedAt: '2026-11-06T09:00:00.000Z' };
			users.push(u);
			return reply(u, 201);
		}
		const id = path.replace(/^users\//, '');
		if (req.method() === 'PATCH') {
			users = users.map((u) => (u.id === id ? { ...u, admin: req.postDataJSON().admin } : u));
			return reply(users.find((u) => u.id === id));
		}
		if (req.method() === 'DELETE') {
			users = users.filter((u) => u.id !== id);
			return reply({ removed: true });
		}
		return reply({ error: 'Not found.' }, 404);
	});
	return calls;
}

const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'admin@example.com', admin: true, addedBy: 'operator', addedAt: '2026-11-01T00:00:00.000Z' };
const MEMBER = { id: '00000000-0000-4000-8000-0000000000bb', email: 'member@example.com', admin: false, addedBy: 'admin@example.com', addedAt: '2026-11-02T00:00:00.000Z' };
const me = (u: U): Me => ({ id: u.id, email: u.email, admin: u.admin });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const table = (page: Page) => page.getByRole('table', { name: 'Users' });
const signinPage = (page: Page) => page.getByRole('textbox', { name: 'Email address' });

test.describe('users', () => {
	test('a copy with no user list offers no Users page, and says so if it is opened', async ({ page }) => {
		await page.goto(MAP);
		await expect(nav(page).getByRole('link', { name: 'Map and compliance' })).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
		await page.goto('users/');
		await expect(page.getByText('This copy of the site has no user list.')).toBeVisible();
	});

	test('a user who is not an admin sees who they are signed in as, and no Users page', async ({ page }) => {
		await host(page, me(MEMBER));
		await page.goto(MAP);
		await expect(page.getByText('Signed in as member@example.com')).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
		await page.goto('users/');
		await expect(page.getByText('Only an admin can manage users')).toBeVisible();
		await expect(table(page)).toHaveCount(0);
	});

	test('a session that is over sends the person to sign in, and back here afterwards', async ({ page }) => {
		await host(page, me(ADMIN), [], { signedIn: () => false });
		await page.goto('users/');
		await expect(page).toHaveURL(/\/signin\/\?next=%2Fusers%2F$/);
		await expect(signinPage(page)).toBeFocused();
	});

	test('a session that ends while the page is open sends the person to sign in on the next call', async ({ page }) => {
		let live = true;
		await host(page, me(ADMIN), [ADMIN, MEMBER], { signedIn: () => live });
		await page.goto('users/');
		await expect(table(page)).toBeVisible();
		live = false;
		await page.getByRole('button', { name: 'Make admin member@example.com' }).click();
		await expect(page).toHaveURL(/\/signin\/\?next=%2Fusers%2F$/);
	});

	test('the file cookies are renewed every 10 minutes while the app is open, and a refused refresh signs out', async ({ page }) => {
		await page.clock.install();
		let live = true;
		const calls = await host(page, me(MEMBER), [], { signedIn: () => live });
		await page.goto(MAP);
		await expect(page.getByText('Signed in as member@example.com')).toBeVisible();
		const refreshes = () => calls.filter((c) => c.url().endsWith('/api/auth/refresh')).length;
		expect(refreshes()).toBe(0);
		await page.clock.runFor('10:00');
		await expect.poll(refreshes).toBe(1);
		live = false;
		await page.clock.runFor('10:00');
		await expect(page).toHaveURL(/\/signin\/\?next=/);
	});

	test('Sign out ends the session and opens the sign-in page', async ({ page }) => {
		const calls = await host(page, me(MEMBER));
		await page.goto(MAP);
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/signin\/\?next=/);
		const out = calls.find((c) => c.url().endsWith('/api/auth/logout'))!;
		expect(out.method()).toBe('POST');
	});

	test.describe('an admin', () => {
		let calls: Request[];
		test.beforeEach(async ({ page }) => {
			calls = await host(page, me(ADMIN), [ADMIN, MEMBER]);
			await page.goto(MAP);
			await nav(page).getByRole('link', { name: 'Users' }).click();
			await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
		});

		test('sees the list, and cannot change their own account', async ({ page }) => {
			const own = table(page).getByRole('row').filter({ hasText: 'admin@example.com (you)' });
			await expect(own).toContainText('Another admin can change your account.');
			await expect(own.getByRole('button')).toHaveCount(0);
			await expect(table(page).getByRole('row').filter({ hasText: 'member@example.com' })).toContainText('User');
		});

		test('sees no Cloudflare Access controls', async ({ page }) => {
			await expect(page.getByRole('button', { name: 'Sync with Access' })).toHaveCount(0);
			await expect(page.getByText('Cloudflare')).toHaveCount(0);
		});

		test('adds a user, lowercased, and then an admin', async ({ page }) => {
			await page.getByLabel('Email address').fill('New.Person@Example.com');
			await page.getByRole('button', { name: 'Add user' }).click();
			await expect(page.getByRole('status')).toHaveText('Added new.person@example.com. They can sign in now.');
			await expect(table(page).getByRole('row').filter({ hasText: 'new.person@example.com' })).toContainText('admin@example.com');
			await expect(page.getByLabel('Email address')).toHaveValue('');

			await page.getByLabel('Email address').fill('boss@example.com');
			await page.getByRole('checkbox', { name: 'Admin', exact: true }).check();
			await page.getByRole('button', { name: 'Add user' }).click();
			await expect(page.getByRole('status')).toHaveText('Added boss@example.com as an admin. They can sign in now.');
			await expect(table(page).getByRole('row').filter({ hasText: 'boss@example.com' })).toContainText('Admin');
		});

		test("shows the API's reason when it refuses", async ({ page }) => {
			await page.getByLabel('Email address').fill('member@example.com');
			await page.getByRole('button', { name: 'Add user' }).click();
			await expect(page.getByRole('alert')).toHaveText('member@example.com is already on the list.');
		});

		test('makes a user an admin, and back, naming them by id', async ({ page }) => {
			await page.getByRole('button', { name: 'Make admin member@example.com' }).click();
			await expect(page.getByRole('status')).toHaveText('member@example.com is now an admin.');
			await page.getByRole('button', { name: 'Remove admin rights from member@example.com' }).click();
			await expect(page.getByRole('status')).toHaveText('member@example.com is no longer an admin.');
			const patch = calls.find((c) => c.method() === 'PATCH')!;
			expect(new URL(patch.url()).pathname).toMatch(new RegExp(`/api/users/${MEMBER.id}$`));
			expect(patch.postDataJSON()).toEqual({ admin: true });
		});

		test('removes a user only once it is confirmed, and says when their access ends', async ({ page }) => {
			await page.getByRole('button', { name: 'Remove member@example.com' }).click();
			await page.getByRole('button', { name: 'Cancel' }).click();
			await expect(table(page)).toContainText('member@example.com');

			await page.getByRole('button', { name: 'Remove member@example.com' }).click();
			await expect(table(page)).toContainText('Remove member@example.com?');
			await page.getByRole('button', { name: 'Yes, remove' }).click();
			await expect(page.getByRole('status')).toHaveText(
				"Removed member@example.com. They are signed out now, and the site's files close to them within 15 minutes."
			);
			await expect(table(page)).not.toContainText('member@example.com');
			expect(new URL(calls.find((c) => c.method() === 'DELETE')!.url()).pathname).toMatch(new RegExp(`/api/users/${MEMBER.id}$`));
		});

		test('moves focus to Cancel when a removal is asked for, back to Remove on Cancel, and to the outcome once removed', async ({ page }) => {
			const remove = page.getByRole('button', { name: 'Remove member@example.com' });
			await remove.focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(remove).toBeFocused();

			await page.keyboard.press('Enter');
			await page.keyboard.press('Shift+Tab');
			await expect(page.getByRole('button', { name: 'Yes, remove' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('status')).toContainText('Removed member@example.com.');
			await expect(page.getByRole('status')).toBeFocused();
		});

		test('every call asks for JSON, so a session that ran out is a 401 and not a sign-in page', async ({ page }) => {
			await page.getByRole('button', { name: 'Make admin member@example.com' }).click();
			await expect(page.getByRole('status')).toBeVisible();
			expect(calls.length).toBeGreaterThan(2);
			for (const c of calls) expect(c.headers()['x-requested-with']).toBe('XMLHttpRequest');
		});
	});
});
