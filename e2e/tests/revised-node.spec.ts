import { chip, expect, expectRow, historical, legend, loadFile, openNode, optionTexts, panel, select, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

// syr1 at EC B, from the Present Day section of syr1.rul(NEWFORM) in the sample. A cell of the B
// table is 0.19 × (12 - i) × (10 - j), with i = 0 for Oct and j = 0 for the 10th percentile, Mm³:
//         10th     50th     90th     99th
//   May   9.500    5.700    1.900    0.950
//   Jun   7.600    4.560    1.520    0.760
// May converts by ÷ (31 × 0.0864) = ÷ 2.6784: 5.700 → 2.128, 5.130 → 1.915, 1.900 → 0.709.
// Urgent action required is 90% of EWR: 5.130 for May at the 50th, 8.550 at the 10th.
test.describe('Revised node', () => {
	const unitsMm3 = (page: Page) => select(page, /Units/).selectOption({ label: 'Mm³ per month' });
	const percentile = (page: Page) => select(panel(page), /^EWR percentile/);
	const drought = (page: Page) => select(panel(page), /^Drought EWR percentile/);

	test.beforeEach(async ({ page }) => {
		await openNode(page, 'syr1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use B');
	});

	test('uses the 50th percentile for EWR and the 90th for Drought EWR by default', async ({ page }) => {
		await expect(percentile(page)).toHaveValue('50');
		await expect(drought(page)).toHaveValue('90');
		await expect(select(panel(page), /Method/)).toHaveValue('revised');
		await expectRow(historical(page).getByRole('table'), 'May', {
			'EWR Monthly Requirement': '2.128', 'Urgent action required': '1.915', 'Drought EWR': '0.709'
		});
	});

	test('shows May as 5.700 Mm³ with Urgent 10% below', async ({ page }) => {
		await unitsMm3(page);
		await expectRow(historical(page).getByRole('table'), 'May', {
			'EWR Monthly Requirement': '5.700', 'Urgent action required': '5.130', 'Drought EWR': '1.900'
		});
	});

	test('draws all three named lines', async ({ page }) => {
		await expect(legend(historical(page), 'Historical Comparison').getByRole('button')).toHaveText([
			'EWR Monthly Requirement', 'Urgent action required', 'Drought EWR'
		]);
	});

	test('offers ten percentiles for EWR and the 90th and 99th for Drought EWR', async ({ page }) => {
		expect(await optionTexts(percentile(page))).toEqual(['10th', '20th', '30th', '40th', '50th', '60th', '70th', '80th', '90th', '99th']);
		expect(await optionTexts(drought(page))).toEqual(['90th', '99th']);
	});

	test('a percentile change moves the table, and Urgent with it', async ({ page }) => {
		await unitsMm3(page);
		await percentile(page).selectOption('10');
		await expectRow(historical(page).getByRole('table'), 'May', {
			'EWR Monthly Requirement': '9.500', 'Urgent action required': '8.550', 'Drought EWR': '1.900'
		});
	});

	test('the 99th percentile changes Drought EWR and leaves EWR', async ({ page }) => {
		await unitsMm3(page);
		const table = historical(page).getByRole('table');
		await expectRow(table, 'Jun', { 'EWR Monthly Requirement': '4.560', 'Drought EWR': '1.520' });
		await drought(page).selectOption('99');
		await expectRow(table, 'Jun', { 'EWR Monthly Requirement': '4.560', 'Drought EWR': '0.760' });
	});

	test('a percentile choice survives a reload', async ({ page }) => {
		await percentile(page).selectOption('10');
		await page.reload();
		await openNode(page, 'syr1');
		await expect(percentile(page)).toHaveValue('10');
	});
});

// syf1 has flow series only. revised.rul's Present Day cell is (7 - c)(i + 1)(10 - j) × 0.01:
//   TEC C is c = 4 and May is i = 7, so at the 50th (j = 4): 3 × 8 × 6 × 0.01 = 1.440 Mm³,
//   Urgent 1.296, and at the 90th (j = 8): 3 × 8 × 2 × 0.01 = 0.480.
// A value of 9.999 would mean the Natural section was read.
test.describe('adding a Revised .rul', () => {
	test('gives a node with no EC file its lines', async ({ page }) => {
		await openNode(page, 'syf1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use none');
		await expect(panel(page).getByText('This node has flow series only')).toBeVisible();

		await loadFile(panel(page), 'Add Revised .rul', 'revised.rul');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
		await expect(panel(page).getByText('This node has flow series only')).toHaveCount(0);

		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		await expectRow(historical(page).getByRole('table'), 'May', {
			'EWR Monthly Requirement': '1.440', 'Urgent action required': '1.296', 'Drought EWR': '0.480'
		});
		await expect(select(panel(page), /View file/).getByRole('option', { name: 'revised.rul' })).toBeAttached();
	});

	test('the added file stays in the browser and opens in the viewer', async ({ page }) => {
		await openNode(page, 'syf1');
		await loadFile(panel(page), 'Add Revised .rul', 'revised.rul');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
		await select(panel(page), /View file/).selectOption('revised.rul');
		await expect(page.getByRole('dialog').getByLabel('File text')).toContainText('Revised Desktop Model outputs for site: syn1');
	});

	test('refuses a file that is not a Revised output', async ({ page }) => {
		await openNode(page, 'syf1');
		await loadFile(panel(page), 'Add Revised .rul', 'junk.txt');
		await expect(panel(page).getByRole('alert')).toHaveText(
			'junk.txt: Not a Revised Desktop file: the Present Day section header is missing'
		);
		await expect(chip(page, 'EC in use')).toHaveText('EC in use none');
		await expect(historical(page).getByRole('table')).toHaveCount(0);
	});
});
