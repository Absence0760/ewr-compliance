import { expect, expectRow, historical, MAP, openNode, test, USER_API } from '../support/app.ts';
import type { Page, Route } from '@playwright/test';

// The app's own data fetches when the CloudFront cookies have run out. The edge (infra/edge_functions.tf)
// answers such a request with 401 JSON when it carries X-Requested-With, and with a redirect to the sign-in
// page when it does not: the stand-in below does the same, so a fetch without the header would read the
// sign-in page as data and fail here. A 401 gets one refresh of the cookies and one more try
// (session.unauthorized()), then the sign-in page, told to come back.
const ME = { id: '00000000-0000-4000-8000-0000000000aa', email: 'reader@example.com', admin: false };
const DATA = /\/data\/(index|ewr-[a-z]+)\.json$/;

test.use({ refused: DATA });

/** The edge, for one file: refused while `lapsed()` says the cookies have run out. */
async function edge(page: Page, file: RegExp, lapsed: () => boolean) {
	const asked: (string | undefined)[] = [];
	await page.route(file, (route: Route) => {
		const xhr = route.request().headers()['x-requested-with'];
		asked.push(xhr);
		if (!lapsed()) return route.fallback();
		if (!xhr) return route.fulfill({ status: 302, headers: { location: '/signin/?next=%2F' } });
		return route.fulfill({ status: 401, json: { error: 'signin_required', signin: '/signin/' }, headers: { 'cache-control': 'no-store' } });
	});
	return asked;
}

/**
 * The API: signed in, and `refresh` decides whether the session can renew the file cookies. Returns the
 * pages that asked for a refresh (the sign-in page asks too, once the app has sent the person there).
 */
async function api(page: Page, refresh: () => boolean) {
	const refreshes: string[] = [];
	await page.route(USER_API, (route) => {
		const path = new URL(route.request().url()).pathname.replace(/^.*\/api\//, '');
		if (path === 'auth/refresh') {
			refreshes.push(new URL(route.request().headers()['referer'] ?? 'http://x/').pathname);
			return refresh() ? route.fulfill({ json: ME }) : route.fulfill({ status: 401, json: { error: 'You are not signed in.' } });
		}
		return route.fulfill({ json: ME });
	});
	return refreshes;
}

test('a 401 for data/index.json as the app starts sends the person to sign in, and back here after', async ({ page }) => {
	const asked = await edge(page, /\/data\/index\.json$/, () => true);
	await page.goto(MAP);
	await expect(page).toHaveURL(/\/signin\/\?next=%2Fwma%2Fbreede-olifants%2F$/);
	expect(asked[0]).toBe('XMLHttpRequest');
});

test('a 401 for a later file renews the cookies and reads it again', async ({ page }) => {
	let lapsed = false;
	const refreshes = await api(page, () => {
		lapsed = false;
		return true;
	});
	const asked = await edge(page, /\/data\/ewr-[a-z]+\.json$/, () => lapsed);
	await page.goto(MAP);
	await expect(page.getByText(`Signed in as ${ME.email}`)).toBeVisible();
	lapsed = true;
	await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	// SYT1D.tab's November, read from the file the second try got (tab-node.spec.ts has the arithmetic).
	await expectRow(historical(page).getByRole('table'), 'Nov', { 'EWR Monthly Requirement': '0.656' });
	expect(refreshes).toEqual([`/${MAP}`]);
	expect(asked).toEqual(['XMLHttpRequest', 'XMLHttpRequest']);
	await expect(page).toHaveURL(new RegExp(`/${MAP}`));
});

test('a 401 for a later file that the session cannot renew sends the person to sign in', async ({ page }) => {
	let lapsed = false;
	const refreshes = await api(page, () => false);
	await edge(page, /\/data\/ewr-[a-z]+\.json$/, () => lapsed);
	await page.goto(MAP);
	await expect(page.getByText(`Signed in as ${ME.email}`)).toBeVisible();
	lapsed = true;
	const search = page.getByRole('combobox', { name: 'Find a node or site' });
	await search.fill('syt1');
	await search.press('Enter');
	await expect(page).toHaveURL(/\/signin\/\?next=%2Fwma%2Fbreede-olifants%2F/);
	expect(refreshes.filter((p) => p === `/${MAP}`)).toHaveLength(1);
});
