import { expect, openNode, panel, select, test } from '../support/app.ts';

test.describe('notes page', () => {
	test('explains the method', async ({ page }) => {
		await page.goto('notes');
		await expect(page).toHaveTitle('Method and data notes · EWR Compliance Measurement');
		await expect(page.getByRole('heading', { name: 'How the lines are built' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Constructed _Con.txt files' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();
		await expect(page.getByText('using 28 days for February')).toBeVisible();
	});

	test('lists the data review, grouped', async ({ page }) => {
		await page.goto('notes');
		await expect(page.getByRole('heading', { name: 'Data review' })).toBeVisible();
		// Counted from the issues in the sample's index.json.
		await expect(page.getByRole('heading', { name: 'Node codes corrected (2)' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'File is a copy of another EC, so its named EC is not available (1)' })).toBeVisible();
		await expect(page.getByRole('cell', { name: 'Berg/syb1-note.txt' })).toBeVisible();
	});
});

test.describe('file viewer', () => {
	test.beforeEach(async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
	});

	test('opens from the panel and closes with Esc', async ({ page }) => {
		const pick = select(panel(page), /View file/);
		await pick.selectOption('SYT1D.tab');
		const viewer = page.getByRole('dialog', { name: 'Files for syt1' });
		await expect(viewer).toBeVisible();
		await expect(viewer.getByLabel('File text')).toContainText('Ecological Category = D');

		await page.keyboard.press('Escape');
		await expect(viewer).toBeHidden();
		await expect(pick).toHaveValue('');
	});

	test('opens again on the same file after closing', async ({ page }) => {
		const pick = select(panel(page), /View file/);
		await pick.selectOption('SYT1D.tab');
		const viewer = page.getByRole('dialog', { name: 'Files for syt1' });
		await expect(viewer.getByLabel('File text')).toContainText('Ecological Category = D');
		await viewer.getByRole('button', { name: 'Close' }).click();
		await expect(viewer).toBeHidden();
		await pick.selectOption('SYT1D.tab');
		await expect(viewer.getByLabel('File text')).toContainText('Ecological Category = D');
	});

	test('moves between a node\'s files, including the flow series', async ({ page }) => {
		await select(panel(page), /View file/).selectOption('SYT1D.tab');
		const viewer = page.getByRole('dialog', { name: 'Files for syt1' });
		await expect(select(viewer, 'File').getByRole('option')).toHaveCount(6);
		await select(viewer, 'File').selectOption('SYT1D.mrv');
		await expect(viewer.getByLabel('File text')).not.toContainText('Synthetic Desktop output');
		await expect(viewer.getByLabel('File text')).toHaveAttribute('aria-busy', 'false');
		await expect(viewer.getByLabel('File text')).toHaveText(/\d/);
	});
});
