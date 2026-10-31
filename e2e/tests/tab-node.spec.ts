import { chip, expect, expectRow, historical, legend, openNode, panel, select, test } from '../support/app.ts';

// syt1 at EC D, from SYT1D.tab in the sample. Total Flows Maint. / Low Flows Drought, Mm³:
//   Nov 1.700 / 0.900   Feb 0.560 / 0.056
// m³/s is Mm³ × 10⁶ ÷ (days × 86 400), so Nov ÷ 2.592 and Feb, always 28 days, ÷ 2.4192:
//   Nov 0.656 / 0.347   Feb 0.231 / 0.023
// Urgent action required is 90% of EWR: Nov 1.530 Mm³, 0.590 m³/s, and Feb 0.504 Mm³, 0.208 m³/s.
test.describe('.tab node', () => {
	test.beforeEach(async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use D');
	});

	test('EWR and Drought EWR come from the file, in m³/s', async ({ page }) => {
		const table = historical(page).getByRole('table');
		await expectRow(table, 'Nov', { 'EWR Monthly Requirement': '0.656', 'Urgent action required': '0.590', 'Drought EWR': '0.347' });
		await expectRow(table, 'Feb', { 'EWR Monthly Requirement': '0.231', 'Urgent action required': '0.208', 'Drought EWR': '0.023' });
		await expect(historical(page).getByRole('heading', { name: 'Monthly comparison, m³/s' })).toBeVisible();
	});

	test('the Mm³ unit shows the file values', async ({ page }) => {
		await select(panel(page), /Units/).selectOption({ label: 'Mm³ per month' });
		const table = historical(page).getByRole('table');
		await expectRow(table, 'Nov', { 'EWR Monthly Requirement': '1.700', 'Urgent action required': '1.530', 'Drought EWR': '0.900' });
		await expect(historical(page).getByRole('heading', { name: 'Monthly comparison, Mm³' })).toBeVisible();
	});

	test('draws the Urgent line and has no percentile choice', async ({ page }) => {
		const keys = legend(historical(page), 'Historical Comparison');
		await expect(keys.getByRole('button')).toHaveText(['EWR Monthly Requirement', 'Urgent action required', 'Drought EWR']);
		await expect(select(panel(page), /percentile/)).toHaveCount(0);
		await expect(select(panel(page), /Method/).getByRole('option')).toHaveText(['Reserve Desktop (.tab)']);
	});

	test('a legend button hides and shows its line', async ({ page }) => {
		const line = legend(historical(page), 'Historical Comparison').getByRole('button', { name: 'Drought EWR' });
		await expect(line).toHaveAttribute('aria-pressed', 'true');
		await line.click();
		await expect(line).toHaveAttribute('aria-pressed', 'false');
		await line.click();
		await expect(line).toHaveAttribute('aria-pressed', 'true');
	});

	test('the chart describes itself to a screen reader', async ({ page }) => {
		await expect(historical(page).getByRole('img')).toHaveAccessibleName(
			'Historical Comparison. Shows EWR Monthly Requirement, Urgent action required, Drought EWR. Discharge (m³/s) against Month.'
		);
	});
});
