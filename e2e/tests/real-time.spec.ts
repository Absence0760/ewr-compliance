import { chip, chooseSource, expect, expectRow, legend, loadFile, openNode, realTime, select, showRealTime, sourceInUse, sources, test } from '../support/app.ts';
import type { Locator, Page } from '@playwright/test';

// readings-12min.csv: 120 readings a day, alternating 0.01 under and over the day's mean.
//   29 Nov 0.500, 30 Nov 0.700, 1 Dec 0.300 m³/s. Last reading 1 Dec 23:48, 0.310.
// syt1 D, Mm³ ÷ (days × 0.0864): Nov 1.700 ÷ 2.592 = 0.656, Dec 1.300 ÷ 2.6784 = 0.485,
// and Drought EWR Nov 0.900 ÷ 2.592 = 0.347, Dec 0.400 ÷ 2.6784 = 0.149.
//   Nov mean of daily flow: (0.5 + 0.7) ÷ 2 = 0.600. One day meets EWR, both meet Drought EWR.
//   Dec: 0.300, below 0.485, above 0.149.
// Urgent action required is 90% of EWR: Nov 0.590, Dec 0.437. Nov's mean clears it, Dec's does not.
//   Latest: 0.310 ÷ 0.48536 = 64%. In the Nov view: 30 Nov 23:48, 0.710 ÷ 0.65586 = 108%.
const CSV_READ = 'readings-12min.csv. Read 360 readings, 2025-11-29 to 2025-12-01.';
// multi-sheet.xlsx "12 minute": 29 Nov 1.000, 30 Nov 2.000; 240 readings.
const SHEET_READ = 'multi-sheet.xlsx. Read 240 readings, 2025-11-29 to 2025-11-30.';

const stat = (rt: Locator, name: string | RegExp) => rt.getByText(name).locator('..');

async function loadCsv(page: Page) {
	const rt = realTime(page);
	await chooseSource(rt, 'Text file');
	await loadFile(rt, '12-minute flow file', 'readings-12min.csv');
	await expect(rt.getByRole('status').first()).toHaveText(CSV_READ);
	return rt;
}

test.describe('Real Time Comparison', () => {
	test.beforeEach(async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use D');
		await showRealTime(page);
	});

	test('loads 12-minute readings from a CSV', async ({ page }) => {
		const rt = await loadCsv(page);
		const keys = legend(rt, 'Real Time Comparison');
		await expect(keys.getByRole('button')).toHaveText(['Daily mean flow', 'EWR Monthly Requirement', 'Urgent action required', 'Drought EWR', '12-minute readings']);
		await expect(rt.getByRole('img')).toHaveAccessibleName(
			'Real Time Comparison. Shows Daily mean flow, EWR Monthly Requirement, Urgent action required, Drought EWR, 12-minute readings. Discharge (m³/s) against Date, 2025-11-29 to 2025-12-02.'
		);
	});

	test('averages the readings to a daily mean', async ({ page }) => {
		const rt = await loadCsv(page);
		// The chart spans three days, so its centre is midday on the 30th.
		await rt.locator('.u-over').hover();
		const readout = rt.locator('.readout');
		await expect(readout).toContainText('2025-11-30');
		await expect(readout.getByText('Daily mean flow').locator('..')).toContainText('0.700');
	});

	test('compares each month with its EWR', async ({ page }) => {
		const rt = await loadCsv(page);
		const table = rt.getByRole('table');
		await expectRow(table, 'Nov 2025', {
			'Days of data': '2', 'Mean of daily flow': '0.600', 'EWR Monthly Requirement': '0.656', 'Urgent action required': '0.590', 'Drought EWR': '0.347',
			'Days ≥ EWR': '1', 'Days ≥ Drought': '2', 'Status of mean': 'Below EWR'
		});
		await expectRow(table, 'Dec 2025', {
			'Days of data': '1', 'Mean of daily flow': '0.300', 'EWR Monthly Requirement': '0.485', 'Urgent action required': '0.437', 'Drought EWR': '0.149',
			'Days ≥ EWR': '0', 'Days ≥ Drought': '1', 'Status of mean': 'Urgent action required'
		});
	});

	test('reports the latest reading against its month', async ({ page }) => {
		const rt = await loadCsv(page);
		await expect(stat(rt, /^Latest reading/)).toHaveText(/Latest reading, 2025-12-01 23:48\s*0\.310 m³\/s/);
		await expect(stat(rt, 'EWR for Dec')).toContainText('0.485 m³/s');
		await expect(stat(rt, 'Latest as % of EWR')).toContainText('64%');
	});

	test('the month filter narrows the chart and the latest reading', async ({ page }) => {
		const rt = await loadCsv(page);
		const month = select(rt, /^Month/);
		await expect(month.getByRole('option')).toHaveText(['All loaded', 'Dec 2025', 'Nov 2025']);
		await month.selectOption({ label: 'Nov 2025' });
		await expect(stat(rt, /^Latest reading/)).toHaveText(/Latest reading, 2025-11-30 23:48\s*0\.710 m³\/s/);
		await expect(stat(rt, 'EWR for Nov')).toContainText('0.656 m³/s');
		await expect(stat(rt, 'Latest as % of EWR')).toContainText('108%');
		await expect(rt.getByRole('img')).toHaveAccessibleName(/against Days, 2025-11-01 to 2025-12-01\.$/);
	});

	test('draws the 12-minute readings from the start, and can leave them off', async ({ page }) => {
		const rt = await loadCsv(page);
		const keys = legend(rt, 'Real Time Comparison');
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toBeVisible();
		await rt.getByRole('checkbox', { name: 'Show 12-minute readings' }).uncheck();
		await expect(keys.getByRole('button', { name: '12-minute readings' })).toHaveCount(0);
	});

	test('finds the 12-minute sheet of a workbook, whatever its position', async ({ page }) => {
		const rt = realTime(page);
		await chooseSource(rt, 'Spreadsheet');
		await loadFile(rt, '12-minute flow file', 'multi-sheet.xlsx');
		await expect(rt.getByRole('status').first()).toHaveText(SHEET_READ);
		const sheet = select(rt, /^Sheet/);
		await expect(sheet.getByRole('option')).toHaveText(['Notes', 'Monthly', '12 minute']);
		await expect(sheet).toHaveValue('12 minute');
		// Means 1.000 and 2.000, both over the Nov EWR of 0.656.
		await expectRow(rt.getByRole('table'), 'Nov 2025', {
			'Days of data': '2', 'Mean of daily flow': '1.500', 'Days ≥ EWR': '2', 'Status of mean': 'EWR met'
		});
	});

	test('another sheet can be chosen, and says when it will not do', async ({ page }) => {
		const rt = realTime(page);
		await chooseSource(rt, 'Spreadsheet');
		await loadFile(rt, '12-minute flow file', 'multi-sheet.xlsx');
		const sheet = select(rt, /^Sheet/);
		await sheet.selectOption('Monthly');
		await expect(rt.getByRole('alert')).toContainText('This data has monthly values only.');
		await expect(stat(rt, 'Latest as % of EWR')).toHaveCount(0);
		await sheet.selectOption('Notes');
		await expect(rt.getByRole('alert')).toContainText('No flow table found in "Notes".');
		await sheet.selectOption('12 minute');
		await expect(rt.getByRole('status').first()).toHaveText(SHEET_READ);
	});

	test('a monthly file is sent to the other comparison', async ({ page }) => {
		const rt = realTime(page);
		await chooseSource(rt, 'Spreadsheet');
		await loadFile(rt, '12-minute flow file', 'monthly.xlsx');
		await expect(rt.getByRole('alert')).toContainText("use the Historical Comparison's Monthly volumes for it.");
	});

	test('readings in Mm³ are refused, not plotted as m³/s', async ({ page }) => {
		const rt = realTime(page);
		await chooseSource(rt, 'Text file');
		const csv = ['Date,Time,Flow (Mm3)', '2025-11-29,00:00,0.5', '2025-11-29,00:12,0.5', '2025-11-29,00:24,0.5'].join('\n');
		await rt.getByLabel('12-minute flow file').setInputFiles({ name: 'readings-mm3.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
		await expect(rt.getByRole('alert')).toHaveText('readings-mm3.csv. This data is in Mm³. The Real Time Comparison needs flow in m³/s, so it was not loaded.');
		await expect(rt.getByRole('table')).toHaveCount(0);
		await expect(stat(rt, /^Latest reading/)).toHaveCount(0);
	});

	test('offers no choice of unit: readings are m³/s', async ({ page }) => {
		const rt = await loadCsv(page);
		await expect(select(rt, /Values are in/)).toHaveCount(0);
	});

	test('a junk file gets an error', async ({ page }) => {
		const rt = realTime(page);
		await chooseSource(rt, 'Text file');
		await loadFile(rt, '12-minute flow file', 'junk.txt');
		await expect(rt.getByRole('alert')).toContainText('No flow table found in "junk.txt".');
	});

	test('a node with no linked gauge starts on a spreadsheet, and is not offered the DWS store', async ({ page }) => {
		const rt = realTime(page);
		await expect(sourceInUse(rt)).toHaveValue('sheet');
		await expect(rt.getByLabel('12-minute flow file')).toBeVisible();
		await expect(sources(rt).getByRole('radio', { name: /^DWS/ })).toHaveCount(0);
	});
});
