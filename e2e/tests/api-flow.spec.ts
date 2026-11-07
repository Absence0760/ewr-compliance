import { API_STUB, chooseSource, expect, expectRow, historical, loadFile, openNode, panel, realTime, select, showRealTime, test } from '../support/app.ts';
import type { Locator, Page, Route } from '@playwright/test';

const MM3_REFUSED = 'This data is in Mm³. The Real Time Comparison needs flow in m³/s, so it was not loaded.';
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const TEMPLATE = `${API_STUB}flow?station={station}&from={from}&to={to}`;

// Two years, Oct 1 to Sep 12 then Oct 2 to Sep 13. Nov means (2 + 3) ÷ 2 = 2.500 Mm³.
// syt1 D, Mm³: Nov EWR 1.700, so met. Read as m³/s instead: (2 + 3) × 2.592 ÷ 2 = 6.480 Mm³.
const MATRIX = [2000, 2001].map((Year, k) => ({ Year, ...Object.fromEntries(MONTHS.map((m, i) => [m, i + 1 + k])) }));
const MATRIX_READ = 'X0H001. Read 24 months, Oct 2000 to Sep 2002. Layout: year rows by month columns.';

// AbortSignal.timeout runs on the browser's own clock, out of reach of page.clock. These stand in
// for it: each signal is held so a test can fire it, and settled() waits for every fetch to end,
// by which time loadApi has handled the outcome.
async function holdTimeouts(page: Page) {
	await page.addInitScript(() => {
		const held: { ms: number; fire: () => void }[] = [];
		const fetches: Promise<unknown>[] = [];
		const realFetch = window.fetch;
		window.fetch = (...args) => {
			const p = realFetch(...args);
			fetches.push(p);
			return p;
		};
		AbortSignal.timeout = (ms) => {
			const c = new AbortController();
			held.push({ ms, fire: () => c.abort(new DOMException('signal timed out', 'TimeoutError')) });
			return c.signal;
		};
		Object.assign(window, { held, settled: () => Promise.allSettled(fetches) });
	});
}
type Held = typeof window & { held: { ms: number; fire: () => void }[]; settled: () => Promise<unknown> };
/** Fires the timer set for this long, which also proves it was set: the map's live layers hold timers too. */
const fireTimeout = (page: Page, ms: number) =>
	page.evaluate(async (wanted) => {
		const w = window as Held;
		const timer = w.held.find((h) => h.ms === wanted);
		if (!timer) throw new Error(`No ${wanted} ms timeout, only ${w.held.map((h) => h.ms).join(', ')}`);
		timer.fire();
		await w.settled();
	}, ms);
const hang = () => new Promise<void>(() => {});

/** The stub answers every request with this, and returns the URLs it was asked for. */
async function answer(page: Page, respond: (route: Route) => Promise<void>) {
	const urls: URL[] = [];
	await page.route(`**${API_STUB}**`, (route) => {
		urls.push(new URL(route.request().url()));
		return respond(route);
	});
	return urls;
}

/** The Historical Comparison has one address, the monthly volumes API; the Real Time Comparison is given the real-time one. */
async function load(scope: Locator, page: Page, button: string, address = button === 'Load full record' ? 'Monthly volumes API' : 'Real-time API') {
	await chooseSource(scope, 'DWS API');
	await scope.getByRole('textbox', { name: address }).fill(new URL(TEMPLATE, page.url()).href.replace(/%7B/g, '{').replace(/%7D/g, '}'));
	await scope.getByRole('textbox', { name: 'Station' }).fill('X0H001');
	await scope.getByRole('button', { name: button }).click();
}

test.describe('Flow from an API', () => {
	test.beforeEach(async ({ page }) => {
		await holdTimeouts(page);
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	});

	test.describe('Historical Comparison', () => {
		const loadHist = (page: Page) => load(historical(page), page, 'Load full record');
		const status = (hist: Locator) => hist.getByRole('status').first();
		const table = (hist: Locator) => hist.getByRole('table');

		test('loads a year and month matrix and asks for the whole record', async ({ page }) => {
			const urls = await answer(page, (route) => route.fulfill({ json: MATRIX }));
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText(MATRIX_READ);
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '2.500', Years: '2', 'Status of mean': 'EWR met' });
			expect(urls[0].searchParams.get('station')).toBe('X0H001');
			expect(urls[0].searchParams.get('from')).toBe('1900-01-01T00:00:00.000Z');
		});

		test('takes Mm³ per month by default and can be told otherwise', async ({ page }) => {
			await answer(page, (route) => route.fulfill({ json: { rows: MATRIX } }));
			const hist = historical(page);
			await loadHist(page);
			await expect(select(hist, /Values are in/)).toHaveValue('mm3');
			await select(hist, /Values are in/).selectOption({ label: 'm³/s' });
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '6.480' });
		});

		test('reads date rows from CSV', async ({ page }) => {
			await answer(page, (route) => route.fulfill({ contentType: 'text/csv', body: 'Date,Flow\n2000-10,1\n2000-11,2\n2000-12,3\n' }));
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText('X0H001. Read 3 months, Oct 2000 to Dec 2000. Layout: monthly date column.');
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '2.000', Years: '1' });
		});

		for (const [name, json, text] of [
			['an error object', { error: 'Station not found' }, 'The API reported an error: Station not found'],
			['an empty list', [], 'The API returned no rows.'],
			['an empty list in an object', { data: [] }, 'The API returned no rows.']
		] as const) {
			test(`says what is wrong with ${name}`, async ({ page }) => {
				await answer(page, (route) => route.fulfill({ json }));
				const hist = historical(page);
				await loadHist(page);
				await expect(hist.getByRole('alert')).toHaveText(`X0H001. ${text}`);
				await expect(hist.getByRole('columnheader', { name: 'Mean Mm³' })).toHaveCount(0);
			});
		}

		test('says so when the body is a web page', async ({ page }) => {
			await answer(page, (route) => route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>Sign in</title>' }));
			const hist = historical(page);
			await loadHist(page);
			await expect(hist.getByRole('alert')).toContainText('The API returned HTML or XML, not JSON rows or CSV.');
		});

		test('a bad response replaces good data', async ({ page }) => {
			let bad = false;
			await answer(page, (route) => route.fulfill({ json: bad ? [] : MATRIX }));
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText(MATRIX_READ);
			bad = true;
			await hist.getByRole('button', { name: 'Load full record' }).click();
			await expect(hist.getByRole('alert')).toBeVisible();
			await expect(hist.getByRole('columnheader', { name: 'Mean Mm³' })).toHaveCount(0);
		});

		test('a failed request gives the server\'s reason and leaves the flow on show', async ({ page }) => {
			let down = false;
			await answer(page, (route) => (down ? route.fulfill({ status: 500, json: { error: 'Database down' } }) : route.fulfill({ json: MATRIX })));
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText(MATRIX_READ);
			down = true;
			await hist.getByRole('button', { name: 'Load full record' }).click();
			await expect(hist.getByRole('alert')).toHaveText('API request failed: HTTP 500. The API reported an error: Database down');
			await expect(status(hist)).toHaveText(MATRIX_READ);
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '2.500' });
		});

		test('an unreachable address names cross-origin as a cause', async ({ page }) => {
			await answer(page, (route) => route.abort());
			const hist = historical(page);
			await loadHist(page);
			await expect(hist.getByRole('alert')).toContainText('may not allow cross-origin requests from this site.');
		});

		test('a request that never answers times out after 180 seconds', async ({ page }) => {
			await answer(page, hang);
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText('Loading…');
			await fireTimeout(page, 180_000);
			await expect(hist.getByRole('alert')).toHaveText('API request failed: no full response within 180 seconds. The server may be slow or not responding.');
			await expect(status(hist)).toHaveCount(0);
		});

		test('a stale request that times out leaves newer data alone', async ({ page }) => {
			await answer(page, hang);
			const hist = historical(page);
			await loadHist(page);
			await expect(status(hist)).toHaveText('Loading…');
			await chooseSource(hist, 'Spreadsheet');
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expectRow(table(hist), 'Oct', { 'Mean Mm³': '0.800' });
			await fireTimeout(page, 180_000);
			await expect(hist.getByRole('alert')).toHaveCount(0);
			await expectRow(table(hist), 'Oct', { 'Mean Mm³': '0.800' });
		});

		test('an address with no scheme is refused before any request', async ({ page }) => {
			const urls = await answer(page, (route) => route.fulfill({ json: MATRIX }));
			const hist = historical(page);
			await chooseSource(hist, 'DWS API');
			await hist.getByRole('textbox', { name: 'Monthly volumes API' }).fill('stub-api/flow');
			await hist.getByRole('button', { name: 'Load full record' }).click();
			await expect(hist.getByRole('alert')).toHaveText('The API address must start with http:// or https://.');
			expect(urls).toHaveLength(0);
		});

		test('still loads a file once the API has been tried', async ({ page }) => {
			await answer(page, (route) => route.fulfill({ json: [] }));
			const hist = historical(page);
			await loadHist(page);
			await expect(hist.getByRole('alert')).toBeVisible();
			await chooseSource(hist, 'Spreadsheet');
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expect(hist.getByRole('alert')).toHaveCount(0);
			await expectRow(table(hist), 'Oct', { 'Mean Mm³': '0.800' });
		});
	});

	test('the two comparisons keep their own endpoint, across a reload', async ({ page }) => {
		const hist = historical(page);
		await answer(page, (route) => route.fulfill({ json: MATRIX }));
		await load(hist, page, 'Load full record');
		await expect(hist.getByRole('status').first()).toHaveText(MATRIX_READ);
		const address = await hist.getByRole('textbox', { name: 'Monthly volumes API' }).inputValue();

		await showRealTime(page);
		const rt = realTime(page);
		await chooseSource(rt, 'DWS API');
		await expect(rt.getByRole('textbox', { name: 'Real-time API' })).toHaveValue('');

		await page.reload();
		await expect(panel(page)).toBeVisible();
		await chooseSource(hist, 'DWS API');
		await expect(hist.getByRole('textbox', { name: 'Monthly volumes API' })).toHaveValue(address);
		await expect(hist.getByRole('textbox', { name: 'Station' })).toHaveValue('X0H001');
	});

	test('the Real Time Comparison still asks for 31 days in m³/s', async ({ page }) => {
		const readings = Array.from({ length: 240 }, (_, i) => ({
			time: `2025-11-${29 + Math.floor(i / 120)}T${String(Math.floor((i % 120) / 5)).padStart(2, '0')}:${String(((i % 120) % 5) * 12).padStart(2, '0')}:00`,
			flow: 0.5
		}));
		const urls = await answer(page, (route) => route.fulfill({ json: readings }));
		await showRealTime(page);
		const rt = realTime(page);
		await load(rt, page, 'Load daily and real-time flow');
		await expect(rt.getByRole('status').first()).toHaveText('Real-time API, X0H001. Read 240 readings, 2025-11-29 to 2025-11-30.');
		const span = Date.parse(urls[0].searchParams.get('to')!) - Date.parse(urls[0].searchParams.get('from')!);
		expect(span).toBe(31 * 86400000);
	});

	test('the Real Time Comparison asks the daily flow API for the whole record, and draws it with the readings', async ({ page }) => {
		// Oct 1 and 2 from the daily record, and Nov 29 from two readings of 0.5 m³/s.
		const days = [{ date: '2025-10-01', flow: 2 }, { date: '2025-10-02', flow: 4 }];
		const readings = [{ time: '2025-11-29T00:00:00', flow: 0.5 }, { time: '2025-11-29T00:12:00', flow: 0.5 }];
		const urls = await answer(page, (route) => route.fulfill({ json: route.request().url().includes('/daily?') ? days : readings }));
		await showRealTime(page);
		const rt = realTime(page);
		await chooseSource(rt, 'DWS API');
		const address = (path: string) => new URL(`${API_STUB}${path}?station={station}&from={from}&to={to}`, page.url()).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
		await rt.getByRole('textbox', { name: 'Station' }).fill('X0H001');
		await rt.getByRole('textbox', { name: 'Daily flow API' }).fill(address('daily'));
		await rt.getByRole('textbox', { name: 'Real-time API' }).fill(address('flow'));
		await rt.getByRole('button', { name: 'Load daily and real-time flow' }).click();

		await expect(rt.getByRole('status').filter({ hasText: 'Daily flow API, X0H001.' })).toHaveText('Daily flow API, X0H001. Read 2 days, 2025-10-01 to 2025-10-02.');
		await expect(rt.getByRole('status').filter({ hasText: 'X0H001, from the DWS API.' })).toContainText('3 days of flow in 2 months.');
		const daily = urls.find((u) => u.pathname.endsWith('/daily'))!;
		expect(daily.searchParams.get('from')).toMatch(/^1900-01-01/);
		await expect(rt.getByText(/^Latest reading,/)).toBeVisible();
	});

	test('one real-time API can be left blank, and a blank form says what it needs', async ({ page }) => {
		await answer(page, (route) => route.fulfill({ json: [{ time: '2025-10-01T00:00:00', flow: 2 }, { time: '2025-10-01T12:00:00', flow: 2 }] }));
		await showRealTime(page);
		const rt = realTime(page);
		await chooseSource(rt, 'DWS API');
		await rt.getByRole('button', { name: 'Load daily and real-time flow' }).click();
		await expect(rt.getByRole('alert')).toHaveText('Enter the daily flow API address, the real-time API address, or both.');
		await load(rt, page, 'Load daily and real-time flow', 'Daily flow API');
		await expect(rt.getByRole('status').filter({ hasText: 'Daily flow API, X0H001.' })).toContainText('Read 1 day');
	});

	test('the Real Time Comparison times out after 60 seconds', async ({ page }) => {
		await answer(page, hang);
		await showRealTime(page);
		const rt = realTime(page);
		await load(rt, page, 'Load daily and real-time flow');
		await expect(rt.getByRole('status').first()).toHaveText('Real-time API: Loading…');
		await fireTimeout(page, 60_000);
		await expect(rt.getByRole('alert')).toHaveText('Real-time API: API request failed: no full response within 60 seconds. The server may be slow or not responding.');
	});

	test('the Real Time Comparison refuses readings in Mm³ from the API', async ({ page }) => {
		const rows = [{ date: '2025-11-29 00:00', 'Flow (Mm3)': 1 }, { date: '2025-11-29 00:12', 'Flow (Mm3)': 1 }];
		await answer(page, (route) => route.fulfill({ json: rows }));
		await showRealTime(page);
		const rt = realTime(page);
		await load(rt, page, 'Load daily and real-time flow');
		await expect(rt.getByRole('alert')).toHaveText(`Real-time API, X0H001. ${MM3_REFUSED}`);
		await expect(rt.getByRole('table')).toHaveCount(0);
	});

	test('a response of the wrong kind is sent to the other comparison', async ({ page }) => {
		await answer(page, (route) => route.fulfill({ json: MATRIX }));
		await showRealTime(page);
		const rt = realTime(page);
		await load(rt, page, 'Load daily and real-time flow');
		await expect(rt.getByRole('alert')).toContainText('This data has monthly values only.');
	});
});
