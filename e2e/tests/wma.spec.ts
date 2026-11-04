import { MAP, expect, findNode, mapRegion, panel, select, test } from '../support/app.ts';

// The opening screen: a banner, South Africa's WMAs on a map, and the same WMAs as links.
const chooser = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Water Management Areas' });

test.describe('choosing a Water Management Area', () => {
	test('the app opens on a banner, the national map and every WMA, with what each holds', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveTitle('Map and compliance · EWR Compliance Measurement');
		// One title, in the banner: the app bar leaves its own out on this page.
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('EWR Compliance Measurement');
		await expect(page.getByRole('banner').getByRole('heading')).toHaveCount(0);
		await expect(page.getByRole('region', { name: 'Map of Water Management Areas' }).locator('canvas.maplibregl-canvas')).toBeVisible();
		const links = chooser(page).getByRole('link');
		await expect(links).toHaveText([
			/^Limpopo-Olifants\s*No EWR data yet$/,
			/^Inkomati-Usuthu\s*No EWR data yet$/,
			/^Pongola-Mtamvuna\s*No EWR data yet$/,
			/^Vaal-Orange\s*No EWR data yet$/,
			/^Mzimvubu-Tsitsikamma\s*No EWR data yet$/,
			// Every node of the sample: 5 in Gouritz, 2 in Berg, 1 each in Breede and Olifants-Doring.
			/^Breede-Olifants\s*9 EWR nodes$/
		]);
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('the national map names each WMA, and marks the one in focus in the list', async ({ page }) => {
		await page.goto('/');
		const national = page.getByRole('region', { name: 'Map of Water Management Areas' });
		const names = ['Limpopo-Olifants', 'Inkomati-Usuthu', 'Pongola-Mtamvuna', 'Vaal-Orange', 'Mzimvubu-Tsitsikamma', 'Breede-Olifants'];
		for (const name of names) await expect(national.getByText(name, { exact: true })).toBeVisible();
		// Not WMAs, and named for orientation: in grey, and not in the list.
		for (const name of ['Lesotho', 'Eswatini']) {
			await expect(national.getByText(name, { exact: true })).toHaveClass(/\bother\b/);
			await expect(chooser(page).getByRole('link', { name })).toHaveCount(0);
		}
		await chooser(page).getByRole('link', { name: /Vaal-Orange/ }).focus();
		await expect(national.getByText('Vaal-Orange', { exact: true })).toHaveClass(/\bon\b/);
		await expect(national.getByText('Breede-Olifants', { exact: true })).not.toHaveClass(/\bon\b/);
	});

	test('a WMA with data opens on its nodes, and the Nodes table goes back to it', async ({ page }) => {
		await page.goto('/');
		await chooser(page).getByRole('link', { name: /Breede-Olifants/ }).click();
		await expect(page).toHaveURL(new RegExp(`/${MAP}$`));
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		// Away from the home page, the title is the app bar's.
		await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveText('EWR Compliance Measurement');

		await page.getByRole('link', { name: 'Nodes and ECs' }).click();
		await page.getByRole('button', { name: 'Show syr1 on the map' }).click();
		await expect(page).toHaveURL(new RegExp(`/${MAP}$`));
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syr1');
	});

	test('a WMA with no data opens anyway, on its catchments, rivers and gauges, and says so', async ({ page }) => {
		await page.goto('/');
		await chooser(page).getByRole('link', { name: /Vaal-Orange/ }).click();
		await expect(page).toHaveURL(/\/wma\/vaal-orange\/$/);
		const map = mapRegion(page);
		await expect(map.getByRole('status')).toHaveText('No EWR data for Vaal-Orange yet. Its catchments, rivers and flow gauges are shown.');
		await expect(map.getByText('EWR node', { exact: true })).toHaveCount(0);
		await expect(map.getByRole('checkbox', { name: 'Nodes with no EC file' })).toHaveCount(0);
		await expect(select(map, 'Zoom to a basin')).toHaveCount(0);
		await expect(map.getByRole('checkbox', { name: 'Rivers' })).toBeChecked();
		await expect(panel(page).getByRole('heading', { name: 'Vaal-Orange' })).toBeVisible();
		await page.waitForLoadState('networkidle');
		await expect(map.getByRole('alert')).toHaveCount(0);
	});

	test('the list is there to choose from when the national map cannot load its WMAs', async ({ page }) => {
		await page.route(/\/WMA_2023\//, (route) => route.fulfill({ json: { error: { code: 500, message: 'down' } } }));
		await page.goto('/');
		await expect(page.getByRole('alert')).toHaveText('Water Management Areas could not be loaded from the DWS service. Choose one from the list.');
		// No names over a map with no outlines.
		await expect(page.getByRole('region', { name: 'Map of Water Management Areas' }).getByText('Vaal-Orange', { exact: true })).toHaveCount(0);
		await chooser(page).getByRole('link', { name: /Breede-Olifants/ }).click();
		await expect(page).toHaveURL(new RegExp(`/${MAP}$`));
	});

	test('an address for no WMA is not found', async ({ page }) => {
		const res = await page.request.get('wma/atlantis/');
		expect(res.status()).toBe(404);
	});
});

test.describe('rivers', () => {
	// One made-up river, west to east through syt1 at 21.5, -33.5.
	const river = (name: string) => ({
		type: 'FeatureCollection',
		features: [{ type: 'Feature', properties: { n: name, s: 4, c: 'Perennial' }, geometry: { type: 'LineString', coordinates: [[20.5, -33.5], [22.5, -33.5]] } }]
	});

	test('clicking a river names it', async ({ page }) => {
		await page.route('**/geo/rivers-breede-olifants.json', (route) => route.fulfill({ json: river('Test River') }));
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		await expect(map.getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
		await map.getByRole('button', { name: 'Close popup' }).click();

		// The node is at the centre once the flight ends, and the river runs through it, east and west.
		const canvas = page.locator('canvas.maplibregl-canvas');
		const box = (await canvas.boundingBox())!;
		await page.mouse.click(box.x + box.width / 2 - 60, box.y + box.height / 2);
		await expect(map.getByRole('heading', { name: 'Test River' })).toBeVisible();
		await expect(map.getByText('Perennial, Strahler order 4')).toBeVisible();
	});

	test('an unnamed river says so', async ({ page }) => {
		await page.route('**/geo/rivers-breede-olifants.json', (route) => route.fulfill({ json: river('') }));
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		await expect(map.getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
		await map.getByRole('button', { name: 'Close popup' }).click();
		const box = (await page.locator('canvas.maplibregl-canvas').boundingBox())!;
		await page.mouse.click(box.x + box.width / 2 - 60, box.y + box.height / 2);
		await expect(map.getByRole('heading', { name: 'River not named' })).toBeVisible();
	});
});
