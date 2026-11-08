import { expect, expectRow, historical, MAP, openNode, test, USER_API } from '../support/app.ts';
import type { Page, Route } from '@playwright/test';

// The app's own data fetches when the CloudFront cookies have run out. The hosted site answers such a
// request with CloudFront's 403, the sign-in page as its body, whatever headers it carries: CloudFront
// checks the cookies before the edge function runs (infra/site.tf, seen on the first deploy). The edge
// (infra/edge_functions.tf) would answer 401 JSON to a request with X-Requested-With, and a redirect to
// the sign-in page to one without, should a request ever reach it. Each test runs against both. Either
// refusal gets one refresh of the cookies and one more try (session.unauthorized()), then the sign-in
// page, told to come back. Without the 403 handling the app would read the sign-in page as data.
const ME = { id: '00000000-0000-4000-8000-0000000000aa', email: 'reader@example.com', admin: false };
const DATA = /\/data\/(index|ewr-[a-z]+)\.json$/;
const SIGNIN_PAGE = '<!doctype html><title>Sign in · EWR Compliance Measurement</title>';

test.use({ refused: DATA });

type Refusal = 'cloudfront' | 'edge';

/** The site, for one file: refused, as `by` refuses, while `lapsed()` says the cookies have run out. */
async function site(page: Page, file: RegExp, by: Refusal, lapsed: () => boolean) {
	const asked: (string | undefined)[] = [];
	await page.route(file, (route: Route) => {
		const xhr = route.request().headers()['x-requested-with'];
		asked.push(xhr);
		if (!lapsed()) return route.fallback();
		if (by === 'cloudfront') return route.fulfill({ status: 403, contentType: 'text/html', body: SIGNIN_PAGE });
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

for (const [by, name] of [
	['cloudfront', "CloudFront's 403"],
	['edge', "the edge's 401"]
] as const) {
	test(`${name} for data/index.json as the app starts sends the person to sign in, and back here after`, async ({ page }) => {
		const asked = await site(page, /\/data\/index\.json$/, by, () => true);
		await page.goto(MAP);
		await expect(page).toHaveURL(/\/signin\/\?next=%2Fwma%2Fbreede-olifants%2F$/);
		expect(asked[0]).toBe('XMLHttpRequest');
	});

	test(`${name} for a later file renews the cookies and reads it again`, async ({ page }) => {
		let lapsed = false;
		const refreshes = await api(page, () => {
			lapsed = false;
			return true;
		});
		const asked = await site(page, /\/data\/ewr-[a-z]+\.json$/, by, () => lapsed);
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

	test(`${name} for a later file that the session cannot renew sends the person to sign in`, async ({ page }) => {
		let lapsed = false;
		const refreshes = await api(page, () => false);
		await site(page, /\/data\/ewr-[a-z]+\.json$/, by, () => lapsed);
		await page.goto(MAP);
		await expect(page.getByText(`Signed in as ${ME.email}`)).toBeVisible();
		lapsed = true;
		const search = page.getByRole('combobox', { name: 'Find a node or site' });
		await search.fill('syt1');
		await search.press('Enter');
		await expect(page).toHaveURL(/\/signin\/\?next=%2Fwma%2Fbreede-olifants%2F/);
		expect(refreshes.filter((p) => p === `/${MAP}`)).toHaveLength(1);
	});
}
