import { test as plain, type Page } from '@playwright/test';
import { DWS, MAP, expect, findNode, mapRegion, test } from '../support/app.ts';

// The build for /ewr/ on a plain static host (support/static-host.mjs). Paths here take no leading
// slash, which would leave /ewr/. See docs/hosting.md.
const SITE = 'http://localhost:7796/ewr/';

test.use({ baseURL: SITE });
plain.use({ baseURL: SITE });

test.describe('under a sub-path on a plain static host', () => {
	test("a direct load of a WMA's map reads its data from under the path", async ({ page }) => {
		const map = page.waitForResponse(`${SITE}geo/rivers-breede-olifants.json`);
		await page.goto(MAP);
		await map;
		await expect(page.getByRole('link', { name: 'Map and compliance' })).toHaveAttribute('aria-current', 'page');
		const files = page.waitForResponse(`${SITE}data/ewr-gouritz.json`);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await files;
	});

	test("a WMA's map survives a reload, and its link goes back to the chooser", async ({ page }) => {
		await page.goto(MAP);
		await page.reload();
		await expect(page).toHaveURL(`${SITE}${MAP}`);
		await expect(mapRegion(page)).toBeVisible();
		await page.getByRole('link', { name: 'Map and compliance' }).click();
		await expect(page).toHaveURL(SITE);
		await page.getByRole('link', { name: /Breede-Olifants/ }).click();
		await expect(page).toHaveURL(`${SITE}${MAP}`);
	});

	for (const [route, link] of [
		['nodes/', 'Nodes and ECs'],
		['notes/', 'Method and data notes']
	]) {
		test(`${route} loads directly and survives a reload`, async ({ page }) => {
			await page.goto(route);
			await expect(page.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
			await expect(page.getByRole('table').first()).toBeVisible();
			await page.reload();
			await expect(page).toHaveURL(`${SITE}${route}`);
			await expect(page.getByRole('table').first()).toBeVisible();
		});

		test(`${route} without its slash goes to the page`, async ({ page }) => {
			await page.goto(route.slice(0, -1));
			await expect(page).toHaveURL(`${SITE}${route}`);
			await expect(page.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
		});
	}

	// Not the watching `test`: it counts the address without the slash as leaving the site.
	plain('the address of the site without its slash loads the WMA map', async ({ page }) => {
		await page.goto(SITE.slice(0, -1));
		await expect(page).toHaveURL(SITE);
		await expect(page.getByRole('region', { name: 'Map of Water Management Areas' })).toBeVisible();
	});

	test('the links stay under the path', async ({ page }) => {
		await page.goto('./');
		await page.getByRole('link', { name: 'Nodes and ECs' }).click();
		await expect(page).toHaveURL(`${SITE}nodes/`);
		await page.getByRole('link', { name: 'Method and data notes' }).click();
		await expect(page).toHaveURL(`${SITE}notes/`);
		await page.getByRole('link', { name: 'Map and compliance' }).click();
		await expect(page).toHaveURL(SITE);
		const national = page.getByRole('region', { name: 'Map of Water Management Areas' });
		await expect(national).toBeVisible();
		await page.reload();
		await expect(national).toBeVisible();
	});

	// Not the watching `test`: this one is meant to get a 404.
	plain('an unknown address shows the app and its not found page', async ({ page }) => {
		const res = await page.goto('no/such/page');
		expect(res?.status()).toBe(404);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('EWR Compliance Measurement');
		await expect(page.getByText('Not Found')).toBeVisible();
		await page.getByRole('link', { name: 'Nodes and ECs' }).click();
		await expect(page).toHaveURL(`${SITE}nodes/`);
	});
});

test.describe('content security policy', () => {
	test('every built page carries one', async ({ page }) => {
		for (const route of ['./', MAP, 'nodes/', 'notes/']) {
			await page.goto(route);
			await expect(page.locator('meta[http-equiv="content-security-policy"]')).toHaveAttribute('content', /default-src 'none'/);
		}
	});

	const fetchFrom = (page: Page, url: string) =>
		page.evaluate((u) => fetch(u).then((r) => r.status, (e: Error) => e.name), url);

	// The browser calls this site, which serves the DWS store, and the ArcGIS services, and nowhere else.
	// So a script that got into the page could not send a loaded flow file away. src/csp.ts builds the list.
	plain('lets the page reach the ArcGIS services and no other site', async ({ page }) => {
		await page.route(DWS, (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
		await page.route(/^https?:\/\/elsewhere\.example\.test\//, (route) => route.fulfill({ status: 204 }));
		await page.goto('nodes/');
		expect(await fetchFrom(page, 'https://services3.arcgis.com/x/query')).toBe(200);
		expect(await fetchFrom(page, 'https://services8.arcgis.com/x/query')).toBe(200);
		expect(await fetchFrom(page, 'https://elsewhere.example.test/flow')).toBe('TypeError');
		expect(await fetchFrom(page, 'http://elsewhere.example.test/flow')).toBe('TypeError');
	});
});
