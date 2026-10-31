// What every spec imports: `test` watches each page for trouble, the rest are the steps a user takes.
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

export { expect };

/** Chromium's notes on software WebGL. Performance only, and nothing a user sees. */
const KNOWN_NOISE = [/GL Driver Message .*Performance/, /GPU stall due to ReadPixels/, /Automatic fallback to software WebGL/];

/** The DWS boundary service and the gauge layer, which the browser calls directly. Tests answer for them. */
export const DWS = /^https:\/\/services[38]\.arcgis\.com\//;

/** The path of the made-up flow API. Its failures are what the API tests are for, so the watch lets them by. */
export const API_STUB = '/stub-api/';

/** One made-up square, so a test never depends on the service or holds any of its data. */
const boundary = (props: Record<string, string>) => ({
	type: 'FeatureCollection',
	features: [{
		type: 'Feature',
		properties: props,
		geometry: { type: 'Polygon', coordinates: [[[21, -34.2], [21.2, -34.2], [21.2, -34], [21, -34], [21, -34.2]]] }
	}]
});

/**
 * A made-up gauge. The point is down and left of the sample's syt1: labelled when that node is in
 * view, and clear of the node's own label. `test.use({ gaugeAt })` moves it for other data.
 */
const gauges = (at: [number, number]) => ({
	type: 'FeatureCollection',
	features: [{
		type: 'Feature',
		properties: { Station: 'X0H999', Name: 'Test River @ Test Weir', Quat: 'Z80E', Status: 'Active Weirs' },
		geometry: { type: 'Point', coordinates: at }
	}]
});

/** Fails any test whose page logged an error or warning, threw, got a 4xx/5xx, or left the site. */
export const test = base.extend<{ gaugeAt: [number, number]; watch: void }>({
	gaugeAt: [[21.47, -33.55], { option: true }],
	watch: [
		async ({ page, baseURL, gaugeAt }, use) => {
			const trouble: string[] = [];
			await page.route(DWS, (route) =>
				route.fulfill({
					json: route.request().url().includes('Gauging_Weirs')
						? gauges(gaugeAt)
						: route.request().url().includes('/WMA_2004/')
							? boundary({ WMA_Name: 'Gouritz' })
							: boundary({ QUATERNARY: 'Z80D' })
				})
			);
			page.on('console', (m) => {
				if (m.location().url.includes(API_STUB)) return;
				if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_NOISE.some((re) => re.test(m.text()))) {
					trouble.push(`console.${m.type()}: ${m.text()}`);
				}
			});
			page.on('pageerror', (e) => trouble.push(`pageerror: ${e.message}`));
			page.on('request', (r) => {
				if (/^https?:/.test(r.url()) && !r.url().startsWith(baseURL!) && !DWS.test(r.url())) trouble.push(`left the site: ${r.url()}`);
			});
			page.on('response', (r) => {
				if (r.status() >= 400 && !r.url().includes(API_STUB)) trouble.push(`HTTP ${r.status()}: ${r.url()}`);
			});
			await use();
			expect(trouble).toEqual([]);
		},
		{ auto: true }
	]
});

export const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export const mapRegion = (page: Page) => page.getByRole('region', { name: 'Map of EWR nodes and sites' });
export const panel = (page: Page) => page.getByRole('complementary', { name: 'Compliance' });
export const select = (scope: Page | Locator, name: string | RegExp) => scope.getByRole('combobox', { name });

/** The panel's chip, for example `chip(page, 'EC in use')`, which reads "EC in use D". */
export const chip = (page: Page, name: string) => panel(page).getByText(new RegExp(`^${name}`));

/** Find a node with the map's search, as someone who knows its name would. */
/** A search box with a datalist has the combobox role. */
export async function findNode(page: Page, text: string, heading: string = text) {
	const search = page.getByRole('combobox', { name: 'Find a node or site' });
	await search.fill(text);
	await search.press('Enter');
	await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText(heading);
}

/** Open the home route with this node selected. */
export async function openNode(page: Page, text: string, heading: string = text) {
	await page.goto('/');
	await findNode(page, text, heading);
}

export const historical = (page: Page) => page.getByRole('tabpanel', { name: 'Historical Comparison' });
export const realTime = (page: Page) => page.getByRole('tabpanel', { name: 'Real Time Comparison' });

export async function showRealTime(page: Page) {
	await page.getByRole('tab', { name: 'Real Time Comparison' }).click();
	await expect(realTime(page)).toBeVisible();
}

export type Row = Record<string, string>;

/** One table row keyed by its column headers, read in one go so it never mixes two renders. */
export const tableRow = (table: Locator, label: string): Promise<Row | null> =>
	table.evaluate((t: HTMLTableElement, label) => {
		const text = (c: Element | undefined) => c?.textContent?.trim() ?? '';
		const heads = [...t.tHead!.rows[0].cells].map(text);
		const row = [...t.tBodies[0].rows].find((r) => text(r.cells[0]) === label);
		return row ? Object.fromEntries(heads.map((h, i) => [h, text(row.cells[i])])) : null;
	}, label);

/** Wait for a row to show these values. Rows change after a file loads or a choice is made. */
export const expectRow = (table: Locator, label: string, want: Row) =>
	expect.poll(() => tableRow(table, label)).toMatchObject(want);

/** The chart's own legend, which lists every line drawn. */
export const legend = (scope: Locator, title: string) => scope.getByRole('list', { name: `${title} legend` });

export async function loadFile(scope: Locator, label: string, file: string) {
	await scope.getByLabel(label).setInputFiles(fixture(file));
}

export const optionTexts = (control: Locator) => control.getByRole('option').allTextContents();
