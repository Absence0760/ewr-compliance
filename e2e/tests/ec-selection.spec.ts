import { chip, expect, expectRow, findNode, historical, openNode, panel, select, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

const ec = (page: Page) => select(panel(page), /Ecological Category/);
const ecToUse = (page: Page) => page.getByRole('banner').getByRole('combobox', { name: /EC to use/ });

test.describe('choosing the EC', () => {
	test('syr2 uses the Revised method', async ({ page }) => {
		await openNode(page, 'syr2');
		await expect(select(panel(page), /Method/).getByRole('option')).toHaveText(['Revised Reserve Desktop (.rul)']);
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		// syr2.rul(NEWFORM), Present Day, C table, 50th: Jun 0.038 × 3 × 4 × 6 = 2.736, Urgent 2.462.
		await expectRow(historical(page).getByRole('table'), 'Jun', { 'EWR Monthly Requirement': '2.736', 'Urgent action required': '2.462' });
	});

	test('the pull-down lists only the ECs with a file, tagged by what they are', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(ec(page).getByRole('option')).toHaveText(['C', 'C/D', 'D (TEC, REC, PES)']);
		await expect(ec(page)).toHaveValue('D');
	});

	test('a chosen EC changes the lines, and the display follows it', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		const table = historical(page).getByRole('table');
		await expectRow(table, 'Nov', { 'EWR Monthly Requirement': '1.700' });
		await ec(page).selectOption('C');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
		// SYT1C.tab is SYT1D.tab × 2, so Total Flows Maint. for Nov is 3.400.
		await expectRow(table, 'Nov', { 'EWR Monthly Requirement': '3.400' });
	});

	test('says so when the TEC has no file and the closest EC is shown', async ({ page }) => {
		// syn1 has a TEC of C/D and files for B, C and D. C and D are as close; the higher wins.
		await openNode(page, 'syn1');
		await expect(panel(page).getByText('The TEC is C/D but no file exists for that EC. Showing the closest available, C.')).toBeVisible();
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
		await expect(chip(page, 'TEC')).toHaveText('TEC C/D');
	});

	test('the notice goes once a person has chosen an EC', async ({ page }) => {
		await openNode(page, 'syn1');
		const notice = panel(page).getByText('Showing the closest available');
		await expect(notice).toBeVisible();
		await ec(page).selectOption('D');
		await expect(notice).toHaveCount(0);
	});

	test('EC to use changes the EC at every node, and a reload keeps it', async ({ page }) => {
		await openNode(page, 'syr2');
		await expect(ecToUse(page)).toHaveValue('TEC');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');

		await ecToUse(page).selectOption('REC');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use B');
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		await expectRow(historical(page).getByRole('table'), 'Jun', { 'EWR Monthly Requirement': '4.560' });

		await findNode(page, 'syn1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');

		await page.reload();
		await expect(ecToUse(page)).toHaveValue('REC');
	});

	test('a global change restarts a node from the chosen category', async ({ page }) => {
		await openNode(page, 'syr2');
		await ec(page).selectOption('D');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use D');
		await ecToUse(page).selectOption('PES');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
	});
});
