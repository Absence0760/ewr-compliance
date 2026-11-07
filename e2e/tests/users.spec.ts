import { expect, MAP, test, USER_API } from '../support/app.ts';
import type { Page, Request } from '@playwright/test';

// A made-up host with a user list. It keeps the host's rules that the page relies on: an address
// already listed is refused with a reason, and every call must carry X-Requested-With.
type U = { email: string; admin: boolean; addedBy: string; addedAt: string };

async function host(page: Page, me: { email: string; admin: boolean }, start: U[] = []) {
	let users = structuredClone(start);
	const calls: Request[] = [];
	await page.route(USER_API, async (route) => {
		const req = route.request();
		calls.push(req);
		const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
		const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
		if (path === 'me') return reply(me);
		if (!me.admin) return reply({ error: 'Only an admin can manage users.' }, 403);
		if (path === 'users' && req.method() === 'GET') return reply(users);
		if (path === 'users' && req.method() === 'POST') {
			const b = req.postDataJSON();
			const email = String(b.email).trim().toLowerCase();
			if (users.some((u) => u.email === email)) return reply({ error: `${email} is already on the list.` }, 409);
			users.push({ email, admin: b.admin, addedBy: me.email, addedAt: '2026-11-06T09:00:00.000Z' });
			return reply(users.at(-1), 201);
		}
		const email = decodeURIComponent(path.replace(/^users\//, ''));
		if (req.method() === 'PATCH') users = users.map((u) => (u.email === email ? { ...u, admin: req.postDataJSON().admin } : u));
		if (req.method() === 'DELETE') users = users.filter((u) => u.email !== email);
		return reply(null);
	});
	return calls;
}

const ADMIN = { email: 'admin@example.com', admin: true, addedBy: 'setup', addedAt: '2026-11-01T00:00:00.000Z' };
const MEMBER = { email: 'member@example.com', admin: false, addedBy: 'admin@example.com', addedAt: '2026-11-02T00:00:00.000Z' };
const nav = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const table = (page: Page) => page.getByRole('table', { name: 'Users' });

test.describe('users', () => {
	test('a copy with no user list offers no Users page, and says so if it is opened', async ({ page }) => {
		await page.goto(MAP);
		await expect(nav(page).getByRole('link', { name: 'Map and compliance' })).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
		await page.goto('users/');
		await expect(page.getByText('This copy of the site has no user list.')).toBeVisible();
	});

	test('a user who is not an admin sees who they are signed in as, and no Users page', async ({ page }) => {
		await host(page, { email: MEMBER.email, admin: false });
		await page.goto(MAP);
		await expect(page.getByText('Signed in as member@example.com')).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
		await page.goto('users/');
		await expect(page.getByText('Only an admin can manage users')).toBeVisible();
		await expect(table(page)).toHaveCount(0);
	});

	test('an expired sign-in asks for a reload, and does not say the site has no user list', async ({ page }) => {
		await page.route(USER_API, (route) => route.fulfill({ status: 401, json: { error: 'Your sign-in has expired.' } }));
		await page.goto('users/');
		await expect(page.getByRole('alert')).toHaveText('Your sign-in has expired. Reload the page to sign in again.');
		await expect(page.getByText('This copy of the site has no user list.')).toHaveCount(0);
		await expect(nav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
	});

	test.describe('an admin', () => {
		let calls: Request[];
		test.beforeEach(async ({ page }) => {
			calls = await host(page, { email: ADMIN.email, admin: true }, [ADMIN, MEMBER]);
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

		test("shows the host's reason when it refuses", async ({ page }) => {
			await page.getByLabel('Email address').fill('member@example.com');
			await page.getByRole('button', { name: 'Add user' }).click();
			await expect(page.getByRole('alert')).toHaveText('member@example.com is already on the list.');
		});

		test('makes a user an admin, and back', async ({ page }) => {
			await page.getByRole('button', { name: 'Make admin member@example.com' }).click();
			await expect(page.getByRole('status')).toHaveText('member@example.com is now an admin.');
			await page.getByRole('button', { name: 'Remove admin rights from member@example.com' }).click();
			await expect(page.getByRole('status')).toHaveText('member@example.com is no longer an admin.');
			const patch = calls.find((c) => c.method() === 'PATCH')!;
			expect(new URL(patch.url()).pathname).toMatch(/\/api\/users\/member%40example\.com$/);
		});

		test('removes a user only once it is confirmed', async ({ page }) => {
			await page.getByRole('button', { name: 'Remove member@example.com' }).click();
			await page.getByRole('button', { name: 'Cancel' }).click();
			await expect(table(page)).toContainText('member@example.com');

			await page.getByRole('button', { name: 'Remove member@example.com' }).click();
			await expect(table(page)).toContainText('Remove member@example.com?');
			await page.getByRole('button', { name: 'Yes, remove' }).click();
			await expect(page.getByRole('status')).toHaveText('Removed member@example.com. They can no longer open the site.');
			await expect(table(page)).not.toContainText('member@example.com');
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
			await expect(page.getByRole('status')).toHaveText('Removed member@example.com. They can no longer open the site.');
			await expect(page.getByRole('status')).toBeFocused();
		});

		test('every call asks for JSON, so an expired sign-in is an error and not a sign-in page', async ({ page }) => {
			await page.getByRole('button', { name: 'Make admin member@example.com' }).click();
			await expect(page.getByRole('status')).toBeVisible();
			expect(calls.length).toBeGreaterThan(2);
			for (const c of calls) expect(c.headers()['x-requested-with']).toBe('XMLHttpRequest');
		});
	});
});
