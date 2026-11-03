import { expect, expectRow, findNode, legend, openNode, panel, realTime, select, showRealTime, tableRow, test } from '../support/app.ts';
import type { Locator, Page } from '@playwright/test';

// X0H999 in the sample. Jan 2003 is day d × 0.1 m³/s, except that day 4 is missing (code 170), day 7
// has code 91 and day 9 has code 2. Feb has 3 days at 1.000. Mar has two days of 12-minute readings
// with means of 2 and 4. So 35 days of flow in 3 months, 1 coded and 1 missing.
//
// syq1 links to it with a factor of 0.5, so day d is 0.05 d. Jan sums to (496 - 4) × 0.05 = 24.6 over
// 30 days, a mean of 0.820. Its EWR at EC B is 2.000 Mm³ = 0.747 m³/s, met from day 15: 17 days. Its
// Drought EWR is 0.250 Mm³ = 0.093 m³/s, met from day 2, less the missing day: 29 days.
const dayTable = (rt: Locator) => rt.getByRole('table', { name: /^Daily flow/ });
const monthTable = (rt: Locator) => rt.getByRole('table').last();
const month = (rt: Locator) => select(rt, /^Month/);
const CODED = 'Patched or unreliable (quality code)';

async function atSyq1(page: Page) {
	await openNode(page, 'syq1');
	await showRealTime(page);
	return realTime(page);
}

test.describe('daily flow from a linked gauge', () => {
	test('its node opens on the gauge, on the latest month with most of its days, with the factor applied', async ({ page }) => {
		const rt = await atSyq1(page);
		await expect(select(rt, /Data source/)).toHaveValue('gauge');
		await expect(rt.getByRole('status').first()).toContainText('X0H999. 35 days of flow in 3 months. 1 day with a quality code drawn in their own colour, and 1 missing day not drawn.');
		await expect(month(rt)).toHaveValue('2003-01');
		await expect(month(rt).getByRole('option')).toHaveText(['Mar 2003', 'Feb 2003', 'Jan 2003']);
		await expectRow(monthTable(rt), 'Jan 2003', {
			'Days of data': '30', 'Mean of daily flow': '0.820', 'Days ≥ EWR': '17', 'Days ≥ Drought': '29', 'Status of mean': 'EWR met'
		});
	});

	test('a missing day has no flow, and a coded day is real and in its own series', async ({ page }) => {
		const rt = await atSyq1(page);
		await expectRow(dayTable(rt), '2003-01-01', { 'Mean flow': '0.050', 'Quality code': '1' });
		await expectRow(dayTable(rt), '2003-01-04', { 'Mean flow': '–', 'Quality code': '–' });
		await expectRow(dayTable(rt), '2003-01-07', { 'Mean flow': '0.350', 'Quality code': '91' });
		await expectRow(dayTable(rt), '2003-01-09', { 'Mean flow': '0.450', 'Quality code': '2' });
		const keys = legend(rt, 'Real Time Comparison');
		await expect(keys.getByRole('button', { name: 'Daily mean flow, X0H999 × 0.5' })).toBeVisible();
		await expect(keys.getByRole('button', { name: CODED })).toBeVisible();
	});

	test('every month is there to pick, and the months of 12-minute readings show them', async ({ page }) => {
		const rt = await atSyq1(page);
		await month(rt).selectOption({ label: 'Feb 2003' });
		await expectRow(monthTable(rt), 'Feb 2003', { 'Days of data': '3', 'Mean of daily flow': '0.500' });
		await expect(legend(rt, 'Real Time Comparison').getByRole('button', { name: CODED })).toHaveCount(0);

		await month(rt).selectOption({ label: 'Mar 2003' });
		await expectRow(dayTable(rt), '2003-03-01', { 'Mean flow': '1.000', Readings: '2' });
		await expectRow(dayTable(rt), '2003-03-02', { 'Mean flow': '2.000', Readings: '1' });
		await rt.getByRole('checkbox', { name: 'Show 12-minute readings' }).check();
		await expect(legend(rt, 'Real Time Comparison').getByRole('button', { name: '12-minute readings' })).toBeVisible();
	});

	test('the factor is one for the node, in either comparison', async ({ page }) => {
		const rt = await atSyq1(page);
		await rt.getByLabel('Factor on the gauge record').fill('2');
		await rt.getByLabel('Factor on the gauge record').blur();
		await expectRow(monthTable(rt), 'Jan 2003', { 'Mean of daily flow': '3.280' });
		await page.getByRole('tab', { name: 'Historical Comparison' }).click();
		await expect(panel(page).getByRole('tabpanel', { name: 'Historical Comparison' }).getByLabel('Factor on the gauge record')).toHaveValue('2');
	});

	test('the Units switch shows the whole comparison in Mm³, and the outcome stays the same', async ({ page }) => {
		// Jan is 31 days, so 1 m³/s is 2.6784 Mm³. Day 1, 0.050, is 0.134. The mean, 0.820, is 2.196. EWR 2.000, Urgent 1.800, Drought 0.250.
		const rt = await atSyq1(page);
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		await expect(rt.getByRole('heading', { name: 'By month, Mm³' })).toBeVisible();
		await expect(rt.getByRole('heading', { name: 'Daily flow, Jan 2003, Mm³' })).toBeVisible();
		await expect(rt.getByText("each day is the month's volume at that day's flow")).toBeVisible();
		await expectRow(dayTable(rt), '2003-01-01', { 'Mean flow': '0.134' });
		await expectRow(monthTable(rt), 'Jan 2003', {
			'Mean of daily flow': '2.196', 'EWR Monthly Requirement': '2.000', 'Urgent action required': '1.800', 'Drought EWR': '0.250',
			'Days ≥ EWR': '17', 'Days ≥ Drought': '29', 'Status of mean': 'EWR met'
		});
		await select(panel(page), /Units/).selectOption({ label: 'm³/s' });
		await expectRow(monthTable(rt), 'Jan 2003', { 'Mean of daily flow': '0.820', 'EWR Monthly Requirement': '0.747' });
	});

	test('the gauge shows its own flow, unfactored, by month', async ({ page }) => {
		const rt = await atSyq1(page);
		await rt.getByRole('button', { name: 'View gauge record' }).click();
		const gauge = panel(page);
		await expect(gauge.getByRole('heading', { level: 2 })).toHaveText('X0H999');
		await expect(month(gauge).locator('visible=true')).toHaveValue('2003-01');
		await expect.poll(() => tableRow(gauge.getByRole('table', { name: 'Daily flow, Jan 2003' }), '2003-01-07')).toMatchObject({ 'Mean flow': '0.700', 'Quality code': '91' });
		await expect(gauge.getByRole('table', { name: /^Monthly volumes/ })).toBeVisible();
	});

	test('a gauge with flow and no monthly record is offered only where it has something', async ({ page }) => {
		await openNode(page, 'syr2');
		const rt = realTime(page);
		const hist = panel(page).getByRole('tabpanel', { name: 'Historical Comparison' });
		await expect(select(hist, /Data source/).getByRole('option', { name: /Linked gauge/ })).toHaveCount(0);
		await showRealTime(page);
		await expect(select(rt, /Data source/)).toHaveValue('gauge');
		await rt.getByRole('button', { name: 'View gauge record' }).click();
		await expect(panel(page).getByRole('table', { name: 'Daily flow, Jan 2003' })).toBeVisible();
		await expect(panel(page).getByRole('table', { name: /^Monthly volumes/ })).toHaveCount(0);
	});

	test('a node with no gauge goes back to file loading, with nothing left over', async ({ page }) => {
		const rt = await atSyq1(page);
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(select(rt, /Data source/)).toHaveValue('sheet');
		await expect(rt.getByLabel('12-minute flow file')).toBeVisible();
		await expect(rt.getByLabel('Factor on the gauge record')).toHaveCount(0);
	});
});

test('a daily file can be loaded by hand, and its codes are kept', async ({ page }) => {
	await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	await showRealTime(page);
	const rt = realTime(page);
	await select(rt, /Data source/).selectOption({ label: 'Text file' });
	const row = (date: string, v: string, code: string) => `${date}${v.padStart(10)}${code.padStart(6)}`;
	const text = ['DATE     D AVG F/R  QUAL', row('20030101', '1.000', '1'), row('20030102', '', '170'), row('20030103', '3.000', '91')].join('\r\n');
	await rt.getByLabel('12-minute flow file').setInputFiles({ name: 'X0H001.day', mimeType: 'text/plain', buffer: Buffer.from(text) });
	await expect(rt.getByRole('status').first()).toContainText('Read 2 readings, 2003-01-01 to 2003-01-03.');
	await expect(legend(rt, 'Real Time Comparison').getByRole('button', { name: CODED })).toBeVisible();
});
