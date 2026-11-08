import { MAP, expect, mapRegion, mapSettled, nationalMap, test } from '../support/app.ts';
import type { Locator, Page } from '@playwright/test';

// The check itself is in support/app.ts and runs for every test. This spec only makes sure every
// route gets it, opened directly and reached by its link. Each waits until what it loads is in, so
// trouble that comes late is still seen: the app's data, and on a map every live layer.
const ROUTES: { path: string; title: string; link: string; map?: (page: Page) => Locator }[] = [
	{ path: '/', title: 'Map and compliance', link: 'Map and compliance', map: nationalMap },
	{ path: 'nodes', title: 'Nodes and ECs', link: 'Nodes and ECs' },
	{ path: 'notes', title: 'Method and data notes', link: 'Method and data notes' },
	// A WMA's map is under the map's link.
	{ path: MAP, title: 'Breede-Olifants · Map and compliance', link: 'Map and compliance', map: mapRegion }
];

test.describe('every route', () => {
	for (const { path, title, link, map } of ROUTES) {
		test(`${title} opens directly with a clean console`, async ({ page }) => {
			await page.goto(path);
			await expect(page).toHaveTitle(`${title} · EWR Compliance Measurement`);
			await expect(page.getByRole('main')).not.toContainText('Could not start');
			await expect(page.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
			await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Loading…' })).toHaveCount(0);
			if (map) await mapSettled(map(page));
		});
	}

	test('the links reach each route, and the map comes back', async ({ page }) => {
		await page.goto(MAP);
		await expect(mapRegion(page)).toBeVisible();
		for (const { title } of [ROUTES[1], ROUTES[2], ROUTES[0]]) {
			await page.getByRole('link', { name: title }).click();
			await expect(page).toHaveTitle(`${title} · EWR Compliance Measurement`);
		}
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await mapSettled(nationalMap(page));
	});
});
