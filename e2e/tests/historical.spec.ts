import { chip, expect, expectRow, findNode, historical, legend, loadFile, openNode, panel, select, tableRow, test } from '../support/app.ts';
import type { Locator } from '@playwright/test';

// monthly.xlsx: 15 years (k = 1 to 15), a month is k × (i + 1) × 0.1 Mm³ with i = 0 for Oct, and
// Feb of k = 3 is blank. Mean of k: 8 over the record, 10.5 over the last ten years (k = 6 to 15).
//   Oct i = 0: 0.800, last ten 1.050.        Nov i = 1: 1.600, last ten 2.100.
//   Feb i = 4, full: (120 - 3) × 0.5 ÷ 14 years = 4.179. Last ten: 5.250 over 10.
//
// syt1 D, Mm³, EWR / Drought EWR: Oct 2.000 / 1.000, Nov 1.700 / 0.900.
//   Nov full: 1.600 is under 1.700 and over 0.900, 94% of EWR, 0.617 m³/s. Last ten: 2.100, met.
//   Oct full: 0.800 is under 1.000. Last ten: 1.050 is over it, and under Urgent, 1.800 (90% of EWR).
//   Nov by year is 0.2 k: EWR met from k = 9, so 7 of 15 (47%) or 7 of 10 (70%).
//   Drought met from k = 5: 11 of 15 (73%).
const XLSX_READ = 'monthly.xlsx. Read 179 months, Oct 2005 to Sep 2020, with 1 missing. Layout: year rows by month columns.';
// monthly-flagged.txt: 3 years × 12 with Nov 2017 blank. Oct is 1#, 2, 3 and the # month is left out. Nov 2, –, 6.
const TEXT_READ = 'monthly-flagged.txt. Read 34 months, Nov 2016 to Sep 2019, with 2 missing. Layout: year rows by month columns.';

const status = (hist: Locator) => hist.getByRole('status').first();
const table = (hist: Locator) => hist.getByRole('table');

test.describe('Historical Comparison', () => {
	test.describe('at syt1', () => {
		test.beforeEach(async ({ page }) => {
			await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
			await expect(chip(page, 'EC in use')).toHaveText('EC in use D');
		});

		test('loads a monthly spreadsheet with its month and missing counts', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expect(status(hist)).toHaveText(XLSX_READ);
		});

		test('shows full record means, counting only the years with data', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expectRow(table(hist), 'Oct', { 'Mean Mm³': '0.800', Years: '15' });
			await expectRow(table(hist), 'Nov', {
				'Mean Mm³': '1.600', 'Mean m³/s': '0.617', '% of EWR': '94', 'Years ≥ EWR': '47%', 'Years ≥ Drought': '73%', Years: '15'
			});
			await expectRow(table(hist), 'Feb', { 'Mean Mm³': '4.179', Years: '14' });
			await expect(select(hist, /^Period/)).toHaveValue('full');
		});

		test('the last 10 years preset sets the period and moves the means', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expect(hist.getByRole('textbox', { name: 'From' })).toHaveValue('2005-10');
			await select(hist, /^Period/).selectOption({ label: 'Last 10 years' });
			await expect(hist.getByRole('textbox', { name: 'From' })).toHaveValue('2010-10');
			await expect(hist.getByRole('textbox', { name: 'To' })).toHaveValue('2020-09');
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '2.100', 'Years ≥ EWR': '70%', Years: '10' });
			await expectRow(table(hist), 'Feb', { 'Mean Mm³': '5.250', Years: '10' });
		});

		test('status text follows the period', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expectRow(table(hist), 'Oct', { 'Status of mean': 'Below Drought EWR' });
			await expectRow(table(hist), 'Nov', { 'Status of mean': 'Below EWR' });
			await select(hist, /^Period/).selectOption({ label: 'Last 10 years' });
			await expectRow(table(hist), 'Oct', { 'Status of mean': 'Urgent action required' });
			await expectRow(table(hist), 'Nov', { 'Status of mean': 'EWR met' });
		});

		test('a shorter period is drawn with the full record over it', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			const keys = legend(hist, 'Historical Comparison');
			await expect(keys.getByRole('button', { name: 'Observed, Oct 2005 to Sep 2020' })).toBeVisible();
			await expect(keys.getByRole('button', { name: 'Observed, full record' })).toHaveCount(0);
			await select(hist, /^Period/).selectOption({ label: 'Last 10 years' });
			await expect(keys.getByRole('button', { name: 'Observed, Oct 2010 to Sep 2020' })).toBeVisible();
			await expect(keys.getByRole('button', { name: 'Observed, full record' })).toBeVisible();
			await hist.getByRole('checkbox', { name: 'Show full record too' }).uncheck();
			await expect(keys.getByRole('button', { name: 'Observed, full record' })).toHaveCount(0);
		});

		test('a custom period can be typed in', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await hist.getByRole('textbox', { name: 'From' }).fill('2018-10');
			await hist.getByRole('textbox', { name: 'From' }).blur();
			await expect(select(hist, /^Period/)).toHaveValue('custom');
			// Hydrological years 2018 and 2019 are k = 14 and 15: Nov is 0.2 × 14.5.
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '2.900', Years: '2' });
		});

		test('the Mm³ unit gives one mean column, not the same one twice', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
			await expect(hist.getByRole('columnheader', { name: 'Mean Mm³' })).toHaveCount(1);
			await expect(hist.getByRole('columnheader', { name: 'Mean m³/s' })).toHaveCount(0);
			await expectRow(table(hist), 'Nov', { 'EWR Monthly Requirement': '1.700', 'Mean Mm³': '1.600' });
		});

		test('reads flags and a blank month from a text file', async ({ page }) => {
			const hist = historical(page);
			await select(hist, /Data source/).selectOption({ label: 'Text file' });
			await loadFile(hist, 'Monthly flow file', 'monthly-flagged.txt');
			await expect(status(hist)).toHaveText(TEXT_READ);
			await expectRow(table(hist), 'Oct', { 'Mean Mm³': '2.500', Years: '2' });
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '4.000', Years: '2' });
			await expectRow(table(hist), 'Dec', { 'Mean Mm³': '6.000', Years: '3' });
		});

		test('a junk file gets an error, not a result', async ({ page }) => {
			const hist = historical(page);
			await select(hist, /Data source/).selectOption({ label: 'Text file' });
			await loadFile(hist, 'Monthly flow file', 'junk.txt');
			await expect(hist.getByRole('alert')).toHaveText(
				'junk.txt. No flow table found in "junk.txt". Expected a row of month names above year rows, or Date and Flow columns.'
			);
			await expect(select(hist, /^Period/)).toHaveCount(0);
			expect(await tableRow(table(hist), 'Nov')).not.toHaveProperty('Mean Mm³');
		});

		test('a readings file is sent to the other comparison', async ({ page }) => {
			const hist = historical(page);
			await select(hist, /Data source/).selectOption({ label: 'Text file' });
			await loadFile(hist, 'Monthly flow file', 'readings-12min.csv');
			await expect(hist.getByRole('alert')).toContainText('Use it in the Real Time Comparison.');
		});

		test('a bad file replaces a good one rather than leaving it on show', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
			await expect(status(hist)).toHaveText(XLSX_READ);
			await select(hist, /Data source/).selectOption({ label: 'Text file' });
			await loadFile(hist, 'Monthly flow file', 'junk.txt');
			await expect(hist.getByRole('alert')).toBeVisible();
			await expect(hist.getByRole('columnheader', { name: 'Mean Mm³' })).toHaveCount(0);
		});

		test('the workbook sheet with monthly data is chosen for this comparison', async ({ page }) => {
			const hist = historical(page);
			await loadFile(hist, 'Monthly flow file', 'multi-sheet.xlsx');
			await expect(select(hist, /^Sheet/)).toHaveValue('Monthly');
			await expectRow(table(hist), 'Nov', { 'Mean Mm³': '1.600' });
		});

		test('says the monthly API is not established', async ({ page }) => {
			const hist = historical(page);
			await select(hist, /Data source/).selectOption({ label: 'API (not yet established)' });
			await expect(hist.getByText('The DWS monthly API is not yet established')).toContainText('the response format is an assumption');
			await expect(hist.getByLabel('Monthly flow file')).toHaveCount(0);
		});
	});

	test('flow loaded first carries across nodes', async ({ page }) => {
		await page.goto('/');
		const hist = historical(page);
		await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
		await expect(status(hist)).toHaveText(XLSX_READ);

		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expectRow(table(hist), 'Nov', { 'Status of mean': 'Below EWR' });
		// syr1 B, Nov: EWR 0.19 × 11 × 6 = 12.540, Drought EWR at the 90th 0.19 × 11 × 2 = 4.180.
		await findNode(page, 'syr1');
		await expectRow(table(hist), 'Nov', { 'Status of mean': 'Below Drought EWR' });
	});

	// syr1 B at the 10th percentile, Mm³, EWR / Urgent: May 9.500 / 8.550, Jun 7.600 / 6.840.
	// Full record means: May 0.8 × 8 = 6.400, Jun 0.9 × 8 = 7.200. Drought EWR is below both.
	test('a Revised node gives the Urgent status at the selected percentile', async ({ page }) => {
		await openNode(page, 'syr1');
		const hist = historical(page);
		await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
		await select(panel(page), /^EWR percentile/).selectOption('10');
		await expectRow(table(hist), 'May', { 'Mean Mm³': '6.400', 'Status of mean': 'Urgent action required' });
		await expectRow(table(hist), 'Jun', { 'Mean Mm³': '7.200', 'Status of mean': 'Below EWR' });
	});
});
