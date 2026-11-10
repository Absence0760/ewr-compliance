import { readdirSync, readFileSync } from 'node:fs';
import {
	chooseSource, DWS_STORE, expect, expectRow, fixture, historical, legend, openNode, realTime, select, serveStore, showDaily, showRealTime, source, sourceInUse, test
} from '../support/app.ts';
import type { Locator, Page } from '@playwright/test';

// The DWS store as the host serves it under dws/: e2e/fixtures/sample-store, written by make-sample-data.mjs.
//
// X0H999 is current, fetched 2024-11-02T04:15Z, 06:15 SAST. Its daily flow is Oct 2024, day d × 0.2 m³/s,
// day 5 missing (code 170) and day 8 coded 91, and its readings two days of Nov 2024, with means 3 and 6.
// syq1 links to it with a factor of 0.5: day d is 0.1 d, and Nov 1 and 2 are 1.5 and 3. So the daily flow is
// 30 days in 1 month, 1 coded and 1 missing, and the readings 3 over 2 days. Oct sums to (496 - 5) × 0.1 = 49.1 over 30 days, a mean of 1.637.
// syq1 is EC B, at 2.5 times the sample's tables: Oct EWR 5.000 Mm³ = 1.867 m³/s over 31 days, Urgent 1.680,
// Drought 2.500 Mm³ = 0.933. Days ≥ EWR from day 19: 13. Days ≥ Drought from day 10: 22.
//
// Its monthly volumes are the gauge's .mon at scale 0.2: (k + 1) × (i + 1) × 0.2 Mm³, × 0.5 at syq1, so
// 0.1 (k + 1)(i + 1). Nov of k = 1 is flagged #, Jan of k = 2 is flagged with no figure, and the store lists
// Dec 2001 (k = 0) as incomplete. Oct: 0.1, 0.2, 0.3, mean 0.200. Nov: 0.2, 0.6, mean 0.400. Dec: 0.6, 0.9,
// mean 0.750. So 33 of its 36 months are used. The gauge's own record at syq1 has Oct 0.100.
//
// X0H998 is out of date, fetched 2024-09-30T04:00Z, with daily flow only: Sep 2024 days 1 to 29 at 1.5 m³/s.
// syr2 links to it with a factor of 1. X0H997, at syb1, is linked but not in the store.
const STORE = Object.fromEntries(readdirSync(fixture('sample-store')).map((f) => [f, JSON.parse(readFileSync(fixture(`sample-store/${f}`), 'utf8'))]));
const DWS_SOURCE = 'DWS (kept current), X0H999';
const monthTable = (scope: Locator) => scope.getByRole('table').last();
const histTable = (scope: Locator) => scope.getByRole('table');
const detail = (scope: Locator, label: string) => source(scope, label).locator('xpath=..').locator('.muted');

async function atSyq1(page: Page, files: Record<string, unknown> = STORE) {
	const asked = await serveStore(page, files);
	await openNode(page, 'syq1');
	return asked;
}

test.describe('the DWS store, kept current', () => {
	test("the Historical Comparison's daily flow reads the store's daily flow for the linked gauge, factored to the node", async ({ page }) => {
		const asked = await atSyq1(page);
		const day = await showDaily(page);
		await expect(sourceInUse(day)).toHaveValue('gauge');
		await expect(detail(day, DWS_SOURCE)).toHaveText('Daily flow, pulled from DWS. Fetched 2 Nov 2024, 06:15 SAST.');
		await chooseSource(day, DWS_SOURCE);
		await expect(day.getByRole('status').filter({ hasText: 'DWS store, X0H999.' })).toHaveText(
			'DWS store, X0H999. Fetched 2 Nov 2024, 06:15 SAST, with daily flow from 2024-10-01 to 2024-10-31.'
		);
		await expect(day.getByRole('status').filter({ hasText: 'from the DWS store' })).toContainText(
			'X0H999, from the DWS store. 30 days of flow in 1 month. 1 day with a quality code drawn in their own colour, and 1 missing day not drawn.'
		);
		await expect(select(day, /^Month/)).toHaveValue('2024-10');
		await expect(select(day, /^Month/).getByRole('option')).toHaveText(['Oct 2024']);
		await expectRow(monthTable(day), 'Oct 2024', {
			'Days of data': '30', 'Mean of daily flow': '1.637', 'EWR Monthly Requirement': '1.867', 'Urgent action required': '1.680', 'Drought EWR': '0.933',
			'Days ≥ EWR': '13', 'Days ≥ Drought': '22'
		});
		await expect(legend(day, 'Historical Comparison, daily flow').getByRole('button', { name: 'Daily flow, X0H999 × 0.5' })).toBeVisible();
		expect(asked).toEqual(['index.json', 'flows-X0H999.json']);
	});

	test("the Real Time Comparison reads the store's 12-minute readings for the linked gauge, from the same file", async ({ page }) => {
		const asked = await atSyq1(page);
		await showRealTime(page);
		const rt = realTime(page);
		await expect(sourceInUse(rt)).toHaveValue('gauge');
		await expect(detail(rt, DWS_SOURCE)).toHaveText('12-minute readings, where DWS has them, pulled from DWS. Fetched 2 Nov 2024, 06:15 SAST.');
		await chooseSource(rt, DWS_SOURCE);
		await expect(rt.getByRole('status').filter({ hasText: 'from the DWS store' })).toContainText(
			'X0H999, from the DWS store. 3 readings over 2 days, averaged to a daily mean flow.'
		);
		await expect(select(rt, /^Month/).getByRole('option')).toHaveText(['Nov 2024']);
		await expectRow(monthTable(rt), 'Nov 2024', { 'Days of data': '2', 'Mean of daily flow': '2.250' });
		await expect(legend(rt, 'Real Time Comparison').getByRole('button', { name: 'Daily mean flow, X0H999 × 0.5' })).toBeVisible();
		expect(asked).toEqual(['index.json', 'flows-X0H999.json']);
	});

	test('the factor is the node\'s own, in the store as on the gauge', async ({ page }) => {
		await atSyq1(page);
		const day = await showDaily(page);
		await chooseSource(day, DWS_SOURCE);
		await day.getByLabel('Factor on the gauge record').fill('1');
		await day.getByLabel('Factor on the gauge record').blur();
		await expectRow(monthTable(day), 'Oct 2024', { 'Mean of daily flow': '3.273' });
		await expect(legend(day, 'Historical Comparison, daily flow').getByRole('button', { name: 'Daily flow, X0H999' })).toBeVisible();
	});

	test('the Historical Comparison reads monthly volumes where the store has them, and the gauge keeps its own', async ({ page }) => {
		await atSyq1(page);
		const hist = historical(page);
		await expect(sourceInUse(hist)).toHaveValue('gauge');
		await expectRow(histTable(hist), 'Oct', { 'Mean Mm³': '0.100', Years: '3' });
		await chooseSource(hist, DWS_SOURCE);
		await expect(hist.getByRole('status').filter({ hasText: 'from the DWS store' })).toContainText('X0H999, from the DWS store. Using 33 months, Oct 2001 to Sep 2004. 3 months flagged # are left out of the means.');
		await expectRow(histTable(hist), 'Oct', { 'Mean Mm³': '0.200', Years: '3' });
		await expectRow(histTable(hist), 'Nov', { 'Mean Mm³': '0.400', Years: '2' });
		await expectRow(histTable(hist), 'Dec', { 'Mean Mm³': '0.750', Years: '2' });
		await expect(hist.getByRole('textbox', { name: 'From' })).toHaveValue('2001-10');
		await chooseSource(hist, 'Linked gauge, X0H999');
		await expectRow(histTable(hist), 'Oct', { 'Mean Mm³': '0.100', Years: '3' });
	});

	test('an out of date station says so, and one with no monthly volumes is not offered them', async ({ page }) => {
		await serveStore(page, STORE);
		await openNode(page, 'syr2');
		const hist = historical(page);
		await expect(source(hist, 'DWS (kept current), X0H998')).toBeDisabled();
		await expect(detail(hist, 'DWS (kept current), X0H998')).toHaveText('The store has no monthly volumes for X0H998 yet.');
		const day = await showDaily(page);
		await expect(detail(day, 'DWS (kept current), X0H998')).toHaveText('Daily flow, pulled from DWS. Fetched 30 Sep 2024, 06:00 SAST, and out of date.');
		await chooseSource(day, 'DWS (kept current), X0H998');
		await expect(day.getByRole('status').filter({ hasText: 'DWS store, X0H998.' })).toHaveText(
			"DWS store, X0H998. Out of date: the store's pulls of X0H998 have stopped keeping it current. Last fetched 30 Sep 2024, 06:00 SAST, with daily flow to 2024-09-29."
		);
		await expectRow(monthTable(day), 'Sep 2024', { 'Days of data': '29', 'Mean of daily flow': '1.500' });
	});

	test('a linked gauge the store does not hold cannot be picked, and says why', async ({ page }) => {
		await serveStore(page, STORE);
		await openNode(page, 'syb1');
		const hist = historical(page);
		await expect(source(hist, 'DWS (kept current), X0H997')).toBeDisabled();
		await expect(detail(hist, 'DWS (kept current), X0H997')).toHaveText('The store holds nothing for X0H997 yet.');
	});

	test('with no store, as on pnpm preview, the source says so after one request, and nothing else breaks', async ({ page }) => {
		const asked: string[] = [];
		page.on('request', (r) => DWS_STORE.test(r.url()) && asked.push(r.url()));
		await openNode(page, 'syq1');
		const hist = historical(page);
		await expect(source(hist, DWS_SOURCE)).toBeDisabled();
		await expect(detail(hist, DWS_SOURCE)).toHaveText('DWS data is not connected to this site yet. Load a file instead.');
		await expect(hist.getByRole('alert')).toHaveCount(0);
		await showRealTime(page);
		await expect(detail(realTime(page), DWS_SOURCE)).toHaveText('DWS data is not connected to this site yet. Load a file instead.');
		await expect(sourceInUse(realTime(page))).toHaveValue('gauge');
		expect(asked).toHaveLength(1);
	});

	test('an index in a format this app does not read is refused, not guessed at', async ({ page }) => {
		await atSyq1(page, { ...STORE, 'index.json': { version: 2, stations: {} } });
		const hist = historical(page);
		await expect(source(hist, DWS_SOURCE)).toBeDisabled();
		await expect(detail(hist, DWS_SOURCE)).toHaveText('The DWS store could not be read: dws/index.json is format version 2; this app reads 1.');
	});

	test('a station file that is missing is said in the comparison', async ({ page }) => {
		const { 'flows-X0H999.json': _, ...rest } = STORE;
		await atSyq1(page, rest);
		await showRealTime(page);
		const rt = realTime(page);
		await chooseSource(rt, DWS_SOURCE);
		await expect(rt.getByRole('alert')).toHaveText("The DWS store's flow for X0H999 could not be loaded: HTTP 404");
	});

	test('a node with no linked gauge is not offered the store', async ({ page }) => {
		await serveStore(page, STORE);
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(historical(page).getByRole('radio', { name: /^DWS/ })).toHaveCount(0);
	});
});

test('the DWS API addresses an older version kept are dropped, and the other choices kept', async ({ page }) => {
	await page.addInitScript(() => {
		if (sessionStorage.getItem('seeded')) return;
		sessionStorage.setItem('seeded', '1');
		localStorage.setItem('ewr', JSON.stringify({
			ecBasis: 'REC', choices: {}, histApi: { url: 'https://example.test/m?s={station}', station: 'X0H001' }, rtApi: { daily: '', readings: 'https://example.test/rt', station: 'X0H001' }
		}));
	});
	await openNode(page, 'syq1');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('ewr'))).toBe(JSON.stringify({ ecBasis: 'REC', choices: {} }));
});
