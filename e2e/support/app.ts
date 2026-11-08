// What every spec imports: `test` watches each page for trouble, the rest are the steps a user takes.
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

export { expect };

/** Chromium's notes on software WebGL. Performance only, and nothing a user sees. */
const KNOWN_NOISE = [/GL Driver Message .*Performance/, /GPU stall due to ReadPixels/, /Automatic fallback to software WebGL/];

/** The DWS boundary service and the gauge layer, which the browser calls directly. Tests answer for them. */
export const DWS = /^https:\/\/services[38]\.arcgis\.com\//;

/**
 * The DWS store, served by the host under dws/ (docs/architecture.md § DWS store), which the test servers do not
 * have. By default it answers 404, as `pnpm preview` does, and the watch lets that by. `serveStore` stands in
 * for a host with one.
 */
export const DWS_STORE = /\/dws\/(index|flows-[^/]+|monthly-[^/]+)\.json$/;

/**
 * The sign-in and user API (server/, behind /api/* on the hosted site), which the test servers do not
 * have. By default it answers 404, as a copy with no user list does, and the watch lets that by.
 * users.spec.ts and signin.spec.ts answer for it.
 */
export const USER_API = /\/api\/(me|users|audit|auth)(\/|$)/;

/** The map of the WMA the sample's basins are in, which most specs work on. */
export const MAP = 'wma/breede-olifants/';

type Box = [number, number, number, number];
const square = ([w, s, e, n]: Box, properties: Record<string, string>) => ({
	type: 'Feature',
	properties,
	geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
});

/** One made-up square, so a test never depends on the service or holds any of its data. */
const boundary = (props: Record<string, string>) => ({ type: 'FeatureCollection', features: [square([21, -34.2, 21.2, -34], props)] });

/**
 * Made-up WMAs: Breede-Olifants takes in every point of the sample, and the quaternary and gauge
 * above. A query for one WMA by name gets that one.
 */
const STUB_WMAS: [string, Box][] = [['Breede_Olifants', [18.5, -34.5, 23.5, -31.5]], ['Vaal_Orange', [24, -31, 28, -27]], ['Lesotho', [27.5, -30.5, 29, -29]]];
function wmas(url: string) {
	const one = /WMA_NAME = '([^']+)'/.exec(new URL(url).searchParams.get('where') ?? '')?.[1];
	return { type: 'FeatureCollection', features: STUB_WMAS.filter(([name]) => !one || name === one).map(([name, box]) => square(box, { WMA_NAME: name })) };
}

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
export const test = base.extend<{ gaugeAt: [number, number]; refused: RegExp | null; watch: void }>({
	gaugeAt: [[21.47, -33.55], { option: true }],
	/**
	 * Files of the site a spec answers with the edge's 401, as for an expired sign-in
	 * (`test.use({ refused })`): the watch lets a 401 for these by, and nothing else.
	 */
	refused: [null, { option: true }],
	watch: [
		async ({ page, baseURL, gaugeAt, refused }, use) => {
			const trouble: string[] = [];
			await page.route(DWS, (route) =>
				route.fulfill({
					json: route.request().url().includes('Gauging_Weirs')
						? gauges(gaugeAt)
						: route.request().url().includes('/WMA_2023/')
							? wmas(route.request().url())
							: route.request().url().includes('/WMA_2004/')
								? boundary({ WMA_Name: 'Gouritz' })
								: boundary({ QUATERNARY: 'Z80D' })
				})
			);
			await page.route(USER_API, (route) => route.fulfill({ status: 404, body: 'Not found' }));
			await page.route(DWS_STORE, (route) => route.fulfill({ status: 404, body: 'Not found' }));
			const wasRefused = (url: string, status = 401) => status === 401 && !!refused?.test(url);
			page.on('console', (m) => {
				if (DWS_STORE.test(m.location().url) || USER_API.test(m.location().url)) return;
				if (wasRefused(m.location().url) && /status of 401/.test(m.text())) return;
				if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_NOISE.some((re) => re.test(m.text()))) {
					trouble.push(`console.${m.type()}: ${m.text()}`);
				}
			});
			page.on('pageerror', (e) => trouble.push(`pageerror: ${e.message}`));
			page.on('request', (r) => {
				if (/^https?:/.test(r.url()) && !r.url().startsWith(baseURL!) && !DWS.test(r.url())) trouble.push(`left the site: ${r.url()}`);
			});
			page.on('response', (r) => {
				if (r.status() >= 400 && !DWS_STORE.test(r.url()) && !USER_API.test(r.url()) && !wasRefused(r.url(), r.status())) trouble.push(`HTTP ${r.status()}: ${r.url()}`);
			});
			await use();
			expect(trouble).toEqual([]);
		},
		{ auto: true }
	]
});

/**
 * Serve a DWS store: each file by its name under dws/, such as `index.json` or `flows-X0H999.json`. A name
 * not given answers 404. Returns the names asked for, in order, so a test can see what was read.
 */
export async function serveStore(page: Page, files: Record<string, unknown>): Promise<string[]> {
	const asked: string[] = [];
	await page.route(DWS_STORE, (route) => {
		const name = new URL(route.request().url()).pathname.replace(/^.*\/dws\//, '');
		asked.push(name);
		return name in files ? route.fulfill({ json: files[name] }) : route.fulfill({ status: 404, body: 'Not found' });
	});
	return asked;
}

export const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export const mapRegion = (page: Page) => page.getByRole('region', { name: 'Map of EWR nodes and sites' });
export const nationalMap = (page: Page) => page.getByRole('region', { name: 'Map of Water Management Areas' });

/**
 * Wait until a map (`mapRegion` or `nationalMap`) is drawn and every live layer has answered, loaded or
 * lost: its canvas is `aria-busy` until then. What a test waits on before saying nothing more went wrong.
 * Not network idle, which a request MapLibre's worker leaves unfinished, when its map goes, can hold off for good.
 */
export const mapSettled = (region: Locator) => expect(region.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
export const panel = (page: Page) => page.getByRole('complementary', { name: 'Compliance' });
export const select = (scope: Page | Locator, name: string | RegExp) => scope.getByRole('combobox', { name });

/** A comparison's Data source: radio buttons, each named by its label and then a line on what it holds. */
export const sources = (scope: Locator) => scope.getByRole('group', { name: 'Data source' });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const source = (scope: Locator, label: string) => sources(scope).getByRole('radio', { name: new RegExp(`^${escape(label)} `) });
export const chooseSource = (scope: Locator, label: string) => source(scope, label).check();
/** The source in use, whose value is gauge, dws, sheet or text. */
export const sourceInUse = (scope: Locator) => sources(scope).getByRole('radio', { checked: true });

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

/** Open the sample's WMA with this node selected. */
export async function openNode(page: Page, text: string, heading: string = text) {
	await page.goto(MAP);
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
