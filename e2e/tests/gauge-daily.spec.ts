import { chooseSource, expect, expectRow, findNode, historical, legend, openNode, panel, realTime, select, showDaily, showRealTime, sourceInUse, sources, tableRow, test } from '../support/app.ts';
import type { Locator, Page } from '@playwright/test';

// X0H999 in the sample. Jan 2003 is day d × 0.1 m³/s, except that day 4 is missing (code 170), day 7
// has code 91 and day 9 has code 2. Feb has 3 days at 1.000. So its daily record is 33 days of flow in
// 2 months, 1 coded and 1 missing. Mar has two days of 12-minute readings with means of 2 and 4, which are
// the Real Time Comparison's, not the daily record's.
//
// syq1 links to it with a factor of 0.5, so day d is 0.05 d. Jan sums to (496 - 4) × 0.05 = 24.6 over
// 30 days, a mean of 0.820. Its EWR at EC B is 2.000 Mm³ = 0.747 m³/s, met from day 15: 17 days. Its
// Drought EWR is 0.250 Mm³ = 0.093 m³/s, met from day 2, less the missing day: 29 days.
const dayTable = (scope: Locator) => scope.getByRole('table', { name: /^Daily flow/ });
const monthTable = (scope: Locator) => scope.getByRole('table').last();
const month = (scope: Locator) => select(scope, /^Month/);
const CODED = 'Patched or unreliable (quality code)';
const CHART = 'Historical Comparison, daily flow';

async function atSyq1(page: Page) {
	await openNode(page, 'syq1');
	return showDaily(page);
}

test.describe('the daily record of a linked gauge, in the Historical Comparison', () => {
	test('its node opens on the gauge, on the latest month with most of its days, with the factor applied', async ({ page }) => {
		const day = await atSyq1(page);
		await expect(sourceInUse(day)).toHaveValue('gauge');
		await expect(day.getByRole('status').first()).toContainText('X0H999. 33 days of flow in 2 months. 1 day with a quality code drawn in their own colour, and 1 missing day not drawn.');
		await expect(month(day)).toHaveValue('2003-01');
		await expect(month(day).getByRole('option')).toHaveText(['Feb 2003', 'Jan 2003']);
		await expectRow(monthTable(day), 'Jan 2003', {
			'Days of data': '30', 'Mean of daily flow': '0.820', 'Days ≥ EWR': '17', 'Days ≥ Drought': '29', 'Status of mean': 'EWR met'
		});
	});

	test('shows each day with its quality code, and draws coded days in their own colour', async ({ page }) => {
		const day = await atSyq1(page);
		await expectRow(dayTable(day), '2003-01-01', { 'Mean flow': '0.050', 'Quality code': '1' });
		await expectRow(dayTable(day), '2003-01-04', { 'Mean flow': '–', 'Quality code': '–' });
		await expectRow(dayTable(day), '2003-01-07', { 'Mean flow': '0.350', 'Quality code': '91' });
		await expectRow(dayTable(day), '2003-01-09', { 'Mean flow': '0.450', 'Quality code': '2' });
		const keys = legend(day, CHART);
		await expect(keys.getByRole('button', { name: 'Daily flow, X0H999 × 0.5' })).toBeVisible();
		await expect(keys.getByRole('button', { name: CODED })).toBeVisible();
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toHaveCount(0);
	});

	test('every month of the record is there to pick', async ({ page }) => {
		const day = await atSyq1(page);
		await month(day).selectOption({ label: 'Feb 2003' });
		await expectRow(monthTable(day), 'Feb 2003', { 'Days of data': '3', 'Mean of daily flow': '0.500' });
		await expect(legend(day, CHART).getByRole('button', { name: CODED })).toHaveCount(0);
	});

	test('the factor is one for the node, in every view', async ({ page }) => {
		const day = await atSyq1(page);
		await day.getByLabel('Factor on the gauge record').fill('2');
		await day.getByLabel('Factor on the gauge record').blur();
		await expectRow(monthTable(day), 'Jan 2003', { 'Mean of daily flow': '3.280' });
		await historical(page).getByRole('radio', { name: /^Monthly volumes/ }).check();
		await expect(historical(page).getByLabel('Factor on the gauge record')).toHaveValue('2');
		await showRealTime(page);
		await expect(realTime(page).getByLabel('Factor on the gauge record')).toHaveValue('2');
	});

	test('the Units switch shows the whole comparison in Mm³, and the outcome stays the same', async ({ page }) => {
		// Jan is 31 days, so 1 m³/s is 2.6784 Mm³. Day 1, 0.050, is 0.134. The mean, 0.820, is 2.196. EWR 2.000, Urgent 1.800, Drought 0.250.
		const day = await atSyq1(page);
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		await expect(day.getByRole('heading', { name: 'By month, Mm³' })).toBeVisible();
		await expect(day.getByRole('heading', { name: 'Daily flow, Jan 2003, Mm³' })).toBeVisible();
		await expect(day.getByText("each day is the month's volume at that day's flow")).toBeVisible();
		await expectRow(dayTable(day), '2003-01-01', { 'Mean flow': '0.134' });
		await expectRow(monthTable(day), 'Jan 2003', {
			'Mean of daily flow': '2.196', 'EWR Monthly Requirement': '2.000', 'Urgent action required': '1.800', 'Drought EWR': '0.250',
			'Days ≥ EWR': '17', 'Days ≥ Drought': '29', 'Status of mean': 'EWR met'
		});
		await select(panel(page), /Units/).selectOption({ label: 'm³/s' });
		await expectRow(monthTable(day), 'Jan 2003', { 'Mean of daily flow': '0.820', 'EWR Monthly Requirement': '0.747' });
	});

	test('the switch back to monthly volumes keeps the monthly comparison as it was', async ({ page }) => {
		const day = await atSyq1(page);
		await day.getByRole('radio', { name: /^Monthly volumes/ }).check();
		await expect(sourceInUse(day)).toHaveValue('gauge');
		await expect(day.getByRole('heading', { name: /^Monthly comparison/ })).toBeVisible();
		await expect(month(day)).toHaveCount(0);
	});

	test('the gauge shows its own flow, unfactored, by month', async ({ page }) => {
		const day = await atSyq1(page);
		await day.getByRole('button', { name: 'View gauge record' }).click();
		const gauge = panel(page);
		await expect(gauge.getByRole('heading', { level: 2 })).toHaveText('X0H999');
		await expect(month(gauge).locator('visible=true')).toHaveValue('2003-01');
		await expect.poll(() => tableRow(gauge.getByRole('table', { name: 'Daily flow, Jan 2003' }), '2003-01-07')).toMatchObject({ 'Mean flow': '0.700', 'Quality code': '91' });
		await expect(gauge.getByRole('table', { name: /^Monthly volumes/ })).toBeVisible();
	});

	test("the gauge's own panel shows its 12-minute readings, unfactored, in the months that have them", async ({ page }) => {
		const day = await atSyq1(page);
		await day.getByRole('button', { name: 'View gauge record' }).click();
		const gauge = panel(page);
		const keys = legend(gauge, 'Daily flow, X0H999');
		const raw = gauge.getByRole('checkbox', { name: 'Show 12-minute readings' });
		await raw.check();
		await expect(gauge.getByText('No 12-minute readings in this month.')).toBeVisible();
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toHaveCount(0);

		await month(gauge).locator('visible=true').selectOption({ label: 'Mar 2003' });
		await expect(gauge.getByText('No 12-minute readings in this month.')).toHaveCount(0);
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toBeVisible();
		await raw.uncheck();
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toHaveCount(0);
	});

	test('a gauge with no 12-minute readings offers no switch for them', async ({ page }) => {
		await openNode(page, 'syr2');
		const day = await showDaily(page);
		await day.getByRole('button', { name: 'View gauge record' }).click();
		await expect(panel(page).getByRole('table', { name: 'Daily flow, Jan 2003' })).toBeVisible();
		await expect(panel(page).getByRole('checkbox', { name: 'Show 12-minute readings' })).toHaveCount(0);
	});

	test('a gauge with flow and no monthly record is offered only where it has something', async ({ page }) => {
		await openNode(page, 'syr2');
		const hist = historical(page);
		await expect(sources(hist).getByRole('radio', { name: /Linked gauge/ })).toHaveCount(0);
		await showDaily(page);
		await expect(sourceInUse(hist)).toHaveValue('gauge');
		await hist.getByRole('button', { name: 'View gauge record' }).click();
		await expect(panel(page).getByRole('table', { name: 'Daily flow, Jan 2003' })).toBeVisible();
		await expect(panel(page).getByRole('table', { name: /^Monthly volumes/ })).toHaveCount(0);
	});

	test('a node with no gauge goes to a spreadsheet, with nothing left over', async ({ page }) => {
		const day = await atSyq1(page);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(sourceInUse(day)).toHaveValue('sheet');
		await expect(day.getByLabel('Daily flow file')).toBeVisible();
		await expect(day.getByLabel('Factor on the gauge record')).toHaveCount(0);
	});
});

test.describe('12-minute readings of a linked gauge, in the Real Time Comparison', () => {
	test('show only the readings and the daily means worked from them, not the daily record', async ({ page }) => {
		// Mar 2003, × 0.5: day 1 reads 0.5 and 1.5, a mean of 1.000; day 2 reads 2.000. Jan and Feb are the daily record's.
		await openNode(page, 'syq1');
		await showRealTime(page);
		const rt = realTime(page);
		await expect(sourceInUse(rt)).toHaveValue('gauge');
		await expect(rt.getByRole('status').first()).toContainText('X0H999. 3 readings over 2 days, averaged to a daily mean flow.');
		await expect(month(rt).getByRole('option')).toHaveText(['Mar 2003']);
		await expectRow(dayTable(rt), '2003-03-01', { 'Mean flow': '1.000', Readings: '2' });
		await expectRow(dayTable(rt), '2003-03-02', { 'Mean flow': '2.000', Readings: '1' });
		await expect(legend(rt, 'Real Time Comparison').getByRole('button', { name: '12-minute readings' })).toBeVisible();
	});

	test('a gauge with no readings says so, and leads to its daily record', async ({ page }) => {
		await openNode(page, 'syr2');
		await showRealTime(page);
		const rt = realTime(page);
		await expect(rt.getByRole('status').first()).toContainText('No 12-minute readings are held for this gauge.');
		await expect(rt.getByRole('table')).toHaveCount(0);
		await rt.getByRole('button', { name: 'Show daily flow' }).click();
		await expect(page.getByRole('tab', { name: 'Historical Comparison' })).toHaveAttribute('aria-selected', 'true');
		await expect(historical(page).getByRole('radio', { name: /^Daily flow/ })).toBeChecked();
		await expect(month(historical(page))).toHaveValue('2003-01');
	});
});

const row = (date: string, v: string, code: string) => `${date}${v.padStart(10)}${code.padStart(6)}`;
const DAY_FILE = { name: 'X0H001.day', mimeType: 'text/plain', buffer: Buffer.from(['DATE     D AVG F/R  QUAL', row('20030101', '1.000', '1'), row('20030102', '', '170'), row('20030103', '3.000', '91')].join('\r\n')) };

test('a daily file can be loaded by hand into daily flow, and its codes are kept', async ({ page }) => {
	await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	const day = await showDaily(page);
	await chooseSource(day, 'Text file');
	await day.getByLabel('Daily flow file').setInputFiles(DAY_FILE);
	await expect(day.getByRole('status').first()).toContainText('Read 2 days, 2003-01-01 to 2003-01-03.');
	await expect(legend(day, CHART).getByRole('button', { name: CODED })).toBeVisible();
});

test('the Real Time Comparison sends a daily file to daily flow', async ({ page }) => {
	await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	await showRealTime(page);
	const rt = realTime(page);
	await chooseSource(rt, 'Text file');
	await rt.getByLabel('12-minute flow file').setInputFiles(DAY_FILE);
	await expect(rt.getByRole('alert')).toHaveText("X0H001.day. This is daily flow, not 12-minute readings. Use it in the Historical Comparison's Daily flow.");
});
