import { expect, mapRegion, test } from '../support/app.ts';

// The check itself is in support/app.ts and runs for every test. This spec only makes sure every
// route gets it, opened directly and reached by its link.
const ROUTES = [
	{ path: '/', title: 'Map and compliance' },
	{ path: 'nodes', title: 'Nodes and ECs' },
	{ path: 'notes', title: 'Method and data notes' }
];

test.describe('every route', () => {
	for (const { path, title } of ROUTES) {
		test(`${title} opens directly with a clean console`, async ({ page }) => {
			await page.goto(path);
			await expect(page).toHaveTitle(`${title} · EWR Compliance Measurement`);
			await expect(page.getByRole('main')).not.toContainText('Could not start');
			await expect(page.getByRole('link', { name: title })).toHaveAttribute('aria-current', 'page');
			await page.waitForLoadState('networkidle');
		});
	}

	test('the links reach each route, and the map comes back', async ({ page }) => {
		await page.goto('/');
		await expect(mapRegion(page)).toBeVisible();
		for (const { title } of [ROUTES[1], ROUTES[2], ROUTES[0]]) {
			await page.getByRole('link', { name: title }).click();
			await expect(page).toHaveTitle(`${title} · EWR Compliance Measurement`);
		}
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await page.waitForLoadState('networkidle');
	});
});
