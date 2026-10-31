import { chip, expect, openNode, panel, select, test } from '../support/app.ts';

// Z10B (S44) in the sample has a gazetted EWR of 43.25% nMAR. Z10B_C_cum.tab gives 21.5%; the
// constructed Z10B_C_Cum_Con.txt gives 43.25%, so it is the one the gazette matches.
const NODE = 'Z10B (S44)';
const MISMATCH = 'This file gives 21.5% of nMAR; the Reserve Gazette gives 43.25%. It matches Z10B_C_Cum_Con.txt (EC C).';

test.describe('Olifants-Doring Z10B (S44)', () => {
	test.beforeEach(async ({ page }) => {
		await openNode(page, NODE);
	});

	test('offers a flow basis, starting on Cumulative', async ({ page }) => {
		const basis = select(panel(page), /Flow basis/);
		await expect(basis.getByRole('option')).toHaveText(['Cumulative', 'Incremental']);
		await expect(basis).toHaveValue('cum');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
	});

	test('the incremental basis uses its own TEC', async ({ page }) => {
		await select(panel(page), /Flow basis/).selectOption('inc');
		await expect(chip(page, 'TEC')).toHaveText('TEC B');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use B');
	});

	test('names the _Con.txt file when the gazette disagrees, until it is chosen', async ({ page }) => {
		const notice = panel(page).getByText(MISMATCH);
		await expect(notice).toBeVisible();
		const source = select(panel(page), /EWR source file/);
		await expect(source).toHaveValue('Cum/Z10B_C_cum.tab');
		await expect(source.getByRole('option')).toHaveText(['Z10B_C_cum.tab', 'Z10B_C_Cum_Con.txt']);

		await source.selectOption({ label: 'Z10B_C_Cum_Con.txt' });
		await expect(notice).toHaveCount(0);
		await expect(panel(page).getByText('Reserve Gazette')).toHaveCount(0);

		await source.selectOption({ label: 'Z10B_C_cum.tab' });
		await expect(notice).toBeVisible();
	});
});
