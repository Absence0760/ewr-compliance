import { expect, expectRow, findNode, historical, legend, loadFile, mapRegion, openNode, panel, select, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

// X0H999 in the sample: year k = 0 to 2 from 2001/2002, month i = 0 for Oct: (k + 1) × (i + 1) × 0.1 Mm³.
// Nov of 2002/2003 (0.400) and Jan of 2003/2004 (no figure) are flagged, so they are left out.
//   Oct: 0.1, 0.2, 0.3, mean 0.200 over 3.    Nov: 0.2, 0.6, mean 0.400 over 2.
//   Jan: 0.4, 0.8, mean 0.600 over 2.         Sep: 1.2, 2.4, 3.6, mean 2.400 over 3.
// syq1 links to it with a factor of 0.5: Oct 0.100, Nov 0.200, Jan 0.300. A factor of 2: Nov 0.800.
const record = (page: Page) => panel(page).getByRole('table', { name: 'Monthly volumes of X0H999 by hydrological year' });
const compare = (page: Page) => historical(page).getByRole('table');
const footRow = (page: Page, name: string) => record(page).locator('tfoot tr').filter({ has: page.getByRole('rowheader', { name }) }).getByRole('cell');

/** The gauge sits 8 px right of its label's end. */
async function clickGauge(page: Page) {
	const map = mapRegion(page);
	const label = map.getByText('X0H999', { exact: true });
	await expect(label).toBeVisible();
	await map.getByRole('button', { name: 'Close popup' }).click();
	const box = await label.boundingBox();
	await page.mouse.click(box!.x + box!.width + 8, box!.y + box!.height / 2);
}

test.describe('a linked gauge', () => {
	test('clicking it on the map shows its monthly volumes, marks # months and takes them out of the mean', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await clickGauge(page);
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('X0H999');
		await expect(panel(page).getByText('Test River @ Test Weir')).toBeVisible();
		await expect(mapRegion(page).getByText('Measured flow for syq1')).toBeVisible();

		const rows = record(page).locator('tbody tr');
		await expect(rows).toHaveCount(3);
		await expect(rows.nth(0).getByRole('rowheader')).toHaveText('2001/2002');
		await expect(rows.nth(0).getByRole('cell').nth(12)).toHaveText('7.800');
		await expect(rows.nth(1).getByRole('cell').nth(1)).toHaveText('0.400 #');
		await expect(rows.nth(2).getByRole('cell').nth(3)).toHaveText('– #');

		await expect(footRow(page, 'Mean').nth(0)).toHaveText('0.200');
		await expect(footRow(page, 'Mean').nth(1)).toHaveText('0.400');
		await expect(footRow(page, 'Mean').nth(3)).toHaveText('0.600');
		await expect(footRow(page, 'Mean').nth(11)).toHaveText('2.400');
		await expect(footRow(page, 'Years used').nth(0)).toHaveText('3');
		await expect(footRow(page, 'Years used').nth(1)).toHaveText('2');

		await panel(page).getByRole('button', { name: 'Back to syt1' }).click();
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syt1 / SYN-SITE1');
		await expect(record(page)).toHaveCount(0);
	});

	test('its node opens on the gauge record with the factor applied, by default', async ({ page }) => {
		await openNode(page, 'syq1');
		const hist = historical(page);
		await expect(select(hist, /Data source/)).toHaveValue('gauge');
		await expect(hist.getByRole('status').first()).toContainText('X0H999. Using 34 months, Oct 2001 to Sep 2004. 2 months flagged # are left out of the means.');
		await expect(hist.getByLabel('Factor on the gauge record')).toHaveValue('0.5');
		await expect(hist.getByText('Invented: the gauge is upstream of the node')).toBeVisible();
		await expectRow(compare(page), 'Oct', { 'Mean Mm³': '0.100', Years: '3' });
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '0.200', Years: '2' });
		await expectRow(compare(page), 'Jan', { 'Mean Mm³': '0.300', Years: '2' });
		await expect(legend(hist, 'Historical Comparison').getByRole('button', { name: 'Observed, X0H999 × 0.5, Oct 2001 to Sep 2004' })).toBeVisible();
	});

	test('the factor can be changed, survives a reload and clears back to the link', async ({ page }) => {
		await openNode(page, 'syq1');
		const factor = historical(page).getByLabel('Factor on the gauge record');
		await factor.fill('2');
		await factor.blur();
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '0.800', Years: '2' });

		await page.reload();
		await findNode(page, 'syq1');
		await expect(factor).toHaveValue('2');
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '0.800', Years: '2' });

		await factor.fill('');
		await factor.blur();
		await expect(factor).toHaveValue('0.5');
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '0.200', Years: '2' });
	});

	test('a factor of nothing is refused and the record stays as it was', async ({ page }) => {
		await openNode(page, 'syq1');
		const hist = historical(page);
		await hist.getByLabel('Factor on the gauge record').fill('0');
		await hist.getByLabel('Factor on the gauge record').blur();
		await expect(hist.getByRole('alert')).toHaveText('0 is not a factor. It must be a number above 0.');
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '0.200', Years: '2' });
	});

	test('the factor applies to the node, and the gauge record stays as published', async ({ page }) => {
		await openNode(page, 'syq1');
		await historical(page).getByRole('button', { name: 'View monthly volumes' }).click();
		await expect(footRow(page, 'Mean').nth(1)).toHaveText('0.400');
		await expect(panel(page).getByText('Measured flow for syq1: X0H999 × 0.5.')).toBeVisible();
	});

	test('a monthly table counts + months, and leaves out gaps and months the daily record shows are incomplete', async ({ page }) => {
		// X0H997: k × (i + 1) Mm³ for k = 1 to 3 from Oct 2001. Oct: 1+, 2, 3 all count, so 2.000 over 3. Nov: 2, 4, 6.
		// Jan: 4, 8 is out, 12, so 8.000 over 2. Mar: 6, 12, then -99.999, so 9.000 over 2.
		await openNode(page, 'syb1');
		const hist = historical(page);
		await expect(select(hist, /Data source/)).toHaveValue('gauge');
		await expectRow(compare(page), 'Oct', { 'Mean Mm³': '2.000', Years: '3' });
		await expectRow(compare(page), 'Nov', { 'Mean Mm³': '4.000', Years: '3' });
		await expectRow(compare(page), 'Jan', { 'Mean Mm³': '8.000', Years: '2' });
		await expectRow(compare(page), 'Mar', { 'Mean Mm³': '9.000', Years: '2' });
		await hist.getByRole('button', { name: 'View monthly volumes' }).click();
		const rows = panel(page).getByRole('table', { name: 'Monthly volumes of X0H997 by hydrological year' }).locator('tbody tr');
		await expect(rows.nth(0).getByRole('cell').nth(0)).toHaveText('1.000+');
		await expect(rows.nth(1).getByRole('cell').nth(3)).toHaveText('8.000 #');
		await expect(rows.nth(2).getByRole('cell').nth(5)).toHaveText('– #');
	});

	test('a node with no gauge has no gauge source, and moving away leaves it', async ({ page }) => {
		await openNode(page, 'syq1');
		await findNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const hist = historical(page);
		await expect(select(hist, /Data source/)).toHaveValue('sheet');
		await expect(select(hist, /Data source/).getByRole('option', { name: /Linked gauge/ })).toHaveCount(0);
		await expect(hist.getByLabel('Factor on the gauge record')).toHaveCount(0);
	});

	test('a loaded file is kept over the gauge, and the source can go back to the gauge', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const hist = historical(page);
		await loadFile(hist, 'Monthly flow file', 'monthly.xlsx');
		await expect(hist.getByRole('status').first()).toContainText('monthly.xlsx. Read 179 months');
		await findNode(page, 'syq1');
		await expect(select(hist, /Data source/)).toHaveValue('sheet');
		await expectRow(compare(page), 'Oct', { 'Mean Mm³': '0.800', Years: '15' });

		await select(hist, /Data source/).selectOption({ label: 'Linked gauge, X0H999' });
		await expectRow(compare(page), 'Oct', { 'Mean Mm³': '0.100', Years: '3' });
		await expect(hist.getByRole('textbox', { name: 'From' })).toHaveValue('2001-10');
	});
});
