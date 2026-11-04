import { MAP, DWS, expect, findNode, mapRegion, panel, select, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

const canvas = (page: Page) => page.locator('canvas.maplibregl-canvas');

/** Wait for the first full frame: a blank background compresses to a few KB, a drawn map doesn't. */
async function drawnFrame(page: Page) {
	await expect.poll(async () => (await canvas(page).screenshot()).length).toBeGreaterThan(30_000);
	let last = await canvas(page).screenshot();
	await expect
		.poll(async () => {
			const now = await canvas(page).screenshot();
			const same = now.equals(last);
			last = now;
			return same;
		})
		.toBe(true);
	return last;
}

const changedFrom = async (page: Page, before: Buffer) => !(await canvas(page).screenshot()).equals(before);

test.describe('map', () => {
	test('draws the layers, with a legend that tells nodes and sites apart', async ({ page }) => {
		await page.goto(MAP);
		await expect(page).toHaveTitle('Breede-Olifants · Map and compliance · EWR Compliance Measurement');
		await expect(canvas(page)).toBeVisible();
		const map = mapRegion(page);
		await expect(map.getByText('EWR node', { exact: true })).toBeVisible();
		await expect(map.getByText('EWR site', { exact: true })).toBeVisible();
		await expect(map.getByText('Basin boundary')).toBeVisible();
		await expect(map.getByText('WMA boundary')).toBeVisible();
		await expect(map.getByRole('checkbox', { name: 'Quaternary catchments' })).toBeChecked();
		await expect(map.getByRole('checkbox', { name: 'Flow gauges', exact: true })).toBeChecked();
		await expect(map.getByRole('checkbox', { name: 'Closed flow gauges' })).not.toBeChecked();

		const before = await drawnFrame(page);
		await map.getByRole('checkbox', { name: 'Rivers' }).uncheck();
		await expect.poll(() => changedFrom(page, before)).toBe(true);
		await expect(map.getByRole('alert')).toHaveCount(0);
	});

	test('says so when the DWS boundaries cannot be loaded, and keeps working', async ({ page }) => {
		await page.route(DWS, (route) => route.fulfill({ json: { error: { message: 'Service unavailable' } } }));
		await page.goto(MAP);
		await expect(mapRegion(page).getByRole('alert')).toHaveText(
			'The WMA boundary could not be loaded from the DWS service. Quaternary catchments could not be loaded from the DWS service. Basin boundaries could not be loaded from the DWS service. Flow gauges could not be loaded. Everything else still works.'
		);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
	});

	test('names only the layer it lost, and draws the others', async ({ page }) => {
		await page.route(/\/WMA_2004\//, (route) => route.fulfill({ json: { error: { code: 400, message: '', details: ['Invalid query'] } } }));
		await page.goto(MAP);
		await expect(mapRegion(page).getByRole('alert')).toHaveText('Basin boundaries could not be loaded from the DWS service. Everything else still works.');
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByText('X0H999', { exact: true })).toBeVisible();
	});

	test('says so when a service answers with nothing at all', async ({ page }) => {
		await page.route(/Gauging_Weirs/, (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
		await page.goto(MAP);
		await expect(mapRegion(page).getByRole('alert')).toHaveText('Flow gauges could not be loaded. Everything else still works.');
	});

	test('a service that never answers holds back nothing else, and ends in a notice', async ({ page }) => {
		// The real limit is LIVE_TIMEOUT_MS, which a test should not sit through.
		await page.addInitScript(() => {
			const timeout = AbortSignal.timeout.bind(AbortSignal);
			AbortSignal.timeout = () => timeout(1000);
		});
		await page.route(/Quaternary_Catchments/, () => {});
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByText('X0H999', { exact: true })).toBeVisible();
		await expect(mapRegion(page).getByRole('alert')).toHaveText('Quaternary catchments could not be loaded from the DWS service. Everything else still works.');
	});

	test('labels a flow gauge, and its popup links to the DWS verified data', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		const label = map.getByText('X0H999', { exact: true });
		await expect(label).toBeVisible();
		await map.getByRole('button', { name: 'Close popup' }).click();

		// The label ends 8 px left of its point, once the flight has ended.
		const box = await label.boundingBox();
		await page.mouse.click(box!.x + box!.width + 8, box!.y + box!.height / 2);
		await expect(map.getByRole('heading', { name: 'X0H999' })).toBeVisible();
		await expect(map.getByText('Test River @ Test Weir', { exact: true })).toBeVisible();
		await expect(map.getByRole('link', { name: 'DWS verified flow data' })).toHaveAttribute(
			'href', 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx?Station=X0H999'
		);

		await map.getByRole('button', { name: 'Close popup' }).click();
		await map.getByRole('checkbox', { name: 'Flow gauges', exact: true }).uncheck();
		await expect(label).toHaveCount(0);
	});

	test('zooms to a basin from the pull-down', async ({ page }) => {
		await page.goto(MAP);
		const zoom = select(mapRegion(page), 'Zoom to a basin');
		await expect(zoom.getByRole('option')).toHaveText(['All basins', 'Berg', 'Breede', 'Gouritz', 'Olifants-Doring']);
		const before = await drawnFrame(page);
		await zoom.selectOption('Berg');
		await expect.poll(() => changedFrom(page, before)).toBe(true);
	});

	test('search selects a node and opens its popup', async ({ page }) => {
		await page.goto(MAP);
		await expect(panel(page).getByRole('heading', { name: 'Select a node on the map' })).toBeVisible();
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		await expect(map.getByRole('heading', { name: 'syt1', exact: true })).toBeVisible();
		await expect(map.getByText('PES D, REC D, TEC D, in use D')).toBeVisible();
		await expect(map.getByText('Sample West, Z80D')).toBeVisible();
	});

	test('search finds a node by the site at it', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'SYN-SITE1', 'syt1 / SYN-SITE1');
	});

	test('search says when nothing has that name', async ({ page }) => {
		await page.goto(MAP);
		const search = page.getByRole('combobox', { name: 'Find a node or site' });
		await search.fill('no-such-node');
		await search.press('Enter');
		await expect(mapRegion(page).getByRole('status')).toHaveText('No node or site called no-such-node');
	});

	// Straight after the page opens, on purpose: the map is still loading.
	test('a site with no node has a popup that says so', async ({ page }) => {
		await page.goto(MAP);
		const search = page.getByRole('combobox', { name: 'Find a node or site' });
		await search.fill('SYN-LOOSE');
		await search.press('Enter');
		const map = mapRegion(page);
		await expect(map.getByRole('heading', { name: 'SYN-LOOSE' })).toBeVisible();
		await expect(map.getByText('No EWR files are linked.')).toBeVisible();
	});

	test('shows both labels at a co-located node and site', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
		await expect(mapRegion(page).getByText('EWR site: SYN-SITE1')).toBeVisible();
	});

	test('a node with no coordinates opens in the panel and says it is not on the map', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syx1');
		await expect(panel(page).getByText('Not on the map: the supplied data gives this node no coordinates or quaternary.')).toBeVisible();
		await expect(panel(page).getByText('No EWR files were supplied for this node.')).toBeVisible();
		await expect(panel(page).getByText('Invented note: this node has no run.')).toBeVisible();
	});

	test('a node with no point of its own says it is approximate, and where', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syq1');
		await expect(panel(page).getByText('Location approximate: no point was supplied for this node, so it is placed inside quaternary Z20C.')).toBeVisible();
	});

	test('clicking a point selects it and opens its popup', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		// The label is placed when the flight ends, with the node at the centre of the canvas.
		await expect(map.getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
		await map.getByRole('button', { name: 'Close popup' }).click();
		await expect(map.getByRole('heading', { name: 'syt1', exact: true })).toHaveCount(0);

		await canvas(page).click();
		await expect(map.getByRole('heading', { name: 'syt1', exact: true })).toBeVisible();
	});

	test('the popup file pull-down opens the viewer', async ({ page }) => {
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const pick = select(mapRegion(page), /View a file/);
		// It starts on the file behind the lines drawn.
		await expect(pick).toHaveValue('SYT1D.tab');
		await pick.selectOption('SYT1CD.tab');
		await mapRegion(page).getByRole('button', { name: 'Open file' }).click();

		const viewer = page.getByRole('dialog', { name: 'Files for syt1' });
		await expect(viewer).toBeVisible();
		await expect(select(viewer, 'File')).toHaveValue('SYT1CD.tab');
		await expect(viewer.getByLabel('File text')).toContainText('Ecological Category = C/D');
	});
	test('without the WMA outline, keeps the catchments and gauges of its box and says what it lost', async ({ page }) => {
		await page.route(/\/WMA_2023\//, (route) => route.fulfill({ json: { error: { code: 400, message: '', details: ['Invalid query'] } } }));
		await page.goto(MAP);
		await expect(mapRegion(page).getByRole('alert')).toHaveText('The WMA boundary could not be loaded from the DWS service. Everything else still works.');
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByText('X0H999', { exact: true })).toBeVisible();
	});

	test("leaves out a gauge in the WMA's box but outside its outline", async ({ page }) => {
		// Inside the stub's box for Breede-Olifants, which the service filters by, and outside its square.
		await page.route(/Gauging_Weirs/, (route) =>
			route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { Station: 'X0H996', Name: 'Outside', Quat: '', Status: 'Active Weirs' }, geometry: { type: 'Point', coordinates: [23.7, -30] } }] } })
		);
		await page.goto(MAP);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByText('X0H996', { exact: true })).toHaveCount(0);
		await expect(mapRegion(page).getByRole('alert')).toHaveCount(0);
	});

	test('the WMA pull-down moves to another WMA, and back to the chooser', async ({ page }) => {
		await page.goto(MAP);
		const wma = select(mapRegion(page), 'Water Management Area');
		await expect(wma).toHaveValue('breede-olifants');
		await wma.selectOption({ label: 'Vaal-Orange' });
		await expect(page).toHaveURL(/\/wma\/vaal-orange\/$/);
		await expect(page).toHaveTitle('Vaal-Orange · Map and compliance · EWR Compliance Measurement');
		await select(mapRegion(page), 'Water Management Area').selectOption({ label: 'All WMAs' });
		await expect(page.getByRole('heading', { name: 'EWR Compliance Measurement', level: 2 })).toBeVisible();
	});
});
