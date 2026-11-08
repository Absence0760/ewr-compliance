import { expect, test, USER_API } from '../support/app.ts';
import { test as plain, type Page, type Request } from '@playwright/test';

// The sign-in page (static/signin/), against a made-up API: an address, a code from the email, then
// back where the person was going. The API's own rules are server/src/app.test.ts's.
const CODE = '123456';
const ME = { id: '00000000-0000-4000-8000-0000000000aa', email: 'admin@example.com', admin: true };

async function api(page: Page, opts: { live?: boolean } = {}) {
	let signedIn = opts.live ?? false;
	const calls: Request[] = [];
	await page.route(USER_API, async (route) => {
		const req = route.request();
		calls.push(req);
		const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
		const reply = (json: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, json, headers });
		if (path === 'auth/code') {
			const { email } = req.postDataJSON();
			if (!/^[^@\s]+@[^@\s]+$/.test(String(email).trim())) return reply({ error: 'Enter a whole email address, such as name@example.com.' }, 400);
			if (String(email).includes('slow')) return reply({ error: 'Wait a little before asking for another code.' }, 429, { 'retry-after': '42' });
			return reply({ accepted: true }, 202);
		}
		if (path === 'auth/verify') {
			if (req.postDataJSON().code !== CODE) return reply({ error: 'That code is wrong or has expired. Check it, or ask for a new one.' }, 400);
			signedIn = true;
			return reply(ME);
		}
		if (!signedIn) return reply({ error: 'You are not signed in.', signin: '/signin/' }, 401);
		return reply(path === 'users' ? [] : ME);
	});
	return calls;
}

const email = (page: Page) => page.getByRole('textbox', { name: 'Email address' });
const code = (page: Page) => page.getByRole('textbox', { name: 'Sign-in code' });

test.describe('sign-in', () => {
	test('asks for an address, then the code, then opens the page asked for', async ({ page }) => {
		const calls = await api(page);
		await page.goto('signin/?next=%2Fnodes%2F');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('EWR Compliance Measurement');
		await expect(email(page)).toBeFocused();

		await email(page).fill(' admin@example.com ');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status')).toHaveText('If admin@example.com is on the list, a code is on its way to it. It can take a minute to arrive.');
		await expect(code(page)).toBeFocused();
		await expect(email(page)).toBeHidden();

		await code(page).fill(CODE);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/nodes\/$/);
		await expect(page.getByText('Signed in as admin@example.com')).toBeVisible();

		const posts = calls.filter((c) => c.method() === 'POST');
		expect(posts.map((c) => new URL(c.url()).pathname)).toEqual(['/api/auth/refresh', '/api/auth/code', '/api/auth/verify']);
		for (const c of posts) {
			expect(c.headers()['content-type']).toBe('application/json');
			expect(c.headers()['x-requested-with']).toBe('XMLHttpRequest');
		}
		expect(posts[2]!.postDataJSON()).toEqual({ email: 'admin@example.com', code: CODE });
	});

	test('says when a code is wrong, and keeps the focus on it', async ({ page }) => {
		await api(page);
		await page.goto('signin/');
		await email(page).fill('admin@example.com');
		await page.getByRole('button', { name: 'Send me a code' }).click();
		await code(page).fill('000000');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired. Check it, or ask for a new one.');
		await expect(code(page)).toBeFocused();
		await expect(page).toHaveURL(/\/signin\/$/);
	});

	test('checks the code and the address before asking', async ({ page }) => {
		const calls = await api(page);
		await page.goto('signin/');
		await email(page).fill('not an address');
		await page.getByRole('button', { name: 'Send me a code' }).click();
		await expect(page.getByRole('alert')).toHaveText('Enter a whole email address, such as name@example.com.');
		await expect(email(page)).toBeFocused();
		await email(page).fill('admin@example.com');
		await page.getByRole('button', { name: 'Send me a code' }).click();
		await code(page).fill('12a');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toHaveText('Enter the 6 digits from the email.');
		expect(calls.filter((c) => c.url().endsWith('/auth/verify'))).toHaveLength(0);
	});

	test('says how long to wait when sending is limited', async ({ page }) => {
		await api(page);
		await page.goto('signin/');
		await email(page).fill('slow@example.com');
		await page.getByRole('button', { name: 'Send me a code' }).click();
		await expect(page.getByRole('alert')).toHaveText('Wait a little before asking for another code. Try again in 42 seconds.');
	});

	test('can go back to change the address', async ({ page }) => {
		await api(page);
		await page.goto('signin/');
		await email(page).fill('admin@example.com');
		await page.getByRole('button', { name: 'Send me a code' }).click();
		await page.getByRole('button', { name: 'Use another address' }).click();
		await expect(email(page)).toBeFocused();
		await expect(code(page)).toBeHidden();
	});

	for (const next of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example%2F', '%2F%5Cevil.example', '%2Fsignin%2F', 'javascript%3Aalert(1)']) {
		test(`goes home, not to next=${next}`, async ({ page, baseURL }) => {
			await api(page);
			const left: string[] = [];
			page.on('request', (r) => {
				if (!r.url().startsWith(baseURL!)) left.push(r.url());
			});
			await page.goto(`signin/?next=${next}`);
			await email(page).fill('admin@example.com');
			await page.getByRole('button', { name: 'Send me a code' }).click();
			await code(page).fill(CODE);
			await page.getByRole('button', { name: 'Sign in' }).click();
			await expect(page).toHaveURL(new URL('/', baseURL).href);
			expect(left).toEqual([]);
		});
	}

	test('skips the code when the session is still live', async ({ page }) => {
		const calls = await api(page, { live: true });
		await page.goto('signin/?next=%2Fnotes%2F');
		await expect(page).toHaveURL(/\/notes\/$/);
		expect(calls.some((c) => c.url().endsWith('/auth/code'))).toBe(false);
	});

	test('just after a sign-out, asks for a code even if the session is still live', async ({ page }) => {
		const calls = await api(page, { live: true });
		await page.goto('signin/?next=%2Fnotes%2F&signedout=1');
		await expect(page.getByRole('status')).toHaveText('You are signed out.');
		await expect(email(page)).toBeFocused();
		expect(calls.some((c) => c.url().endsWith('/auth/refresh'))).toBe(false);
	});

	test('loads nothing from the app, which is behind the sign-in', async ({ page }) => {
		const loaded: string[] = [];
		page.on('request', (r) => loaded.push(new URL(r.url()).pathname));
		await api(page);
		await page.goto('signin/');
		await expect(email(page)).toBeFocused();
		expect(loaded.filter((p) => !p.startsWith('/signin/') && !p.startsWith('/api/'))).toEqual([]);
		expect(loaded).toContain('/signin/signin.js');
	});
});

// CloudFront serves the sign-in page for its own 403 without frame-ancestors, so the page guards
// itself (static/signin/signin.js). Framed from another origin (the sub-path server's port), it hides
// and wires nothing: not even the session refresh it sends on load. Plain test: the guard's own throw
// is the point, so the app fixture's no-page-error rule doesn't apply. The hidden attribute appearing
// is what shows the script ran.
plain('refuses to run inside a frame from another origin', async ({ page }) => {
	const api: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/api/')) api.push(r.url());
	});
	// A real answer from the other server (its empty 404 outside /ewr/), not a routed one: Chrome's
	// local-network checks refuse a localhost frame inside a page that came from no address.
	await page.goto('http://localhost:7796/frame-host');
	await page.evaluate(() => {
		const frame = document.createElement('iframe');
		frame.src = 'http://localhost:7795/signin/';
		frame.width = frame.height = '600';
		document.body.append(frame);
	});
	const frame = page.frameLocator('iframe');
	await expect(frame.locator('html')).toHaveAttribute('hidden', '');
	await expect(frame.getByRole('textbox', { name: 'Email address' })).toBeHidden();
	expect(api).toEqual([]);
});

