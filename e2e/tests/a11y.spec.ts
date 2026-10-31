import { expect, findNode, mapRegion, openNode, panel, test } from '../support/app.ts';

test.describe('keyboard', () => {
	test('the skip link is first, shows on focus and moves to the main content', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('main')).toBeVisible();
		const skip = page.getByRole('link', { name: 'Skip to main content' });
		await expect(skip).not.toBeInViewport();

		await page.keyboard.press('Tab');
		await expect(skip).toBeFocused();
		await expect(skip).toBeInViewport();

		await page.keyboard.press('Enter');
		await expect(page.getByRole('main')).toBeFocused();
	});

	test('arrow keys, Home and End move through the comparison tabs', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const hist = page.getByRole('tab', { name: 'Historical Comparison' });
		const rt = page.getByRole('tab', { name: 'Real Time Comparison' });
		await expect(hist).toHaveAttribute('aria-selected', 'true');

		await hist.focus();
		await page.keyboard.press('ArrowRight');
		await expect(rt).toBeFocused();
		await expect(rt).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('tabpanel', { name: 'Real Time Comparison' })).toBeVisible();
		await expect(page.getByRole('tabpanel', { name: 'Historical Comparison' })).toBeHidden();

		await page.keyboard.press('ArrowRight'); // wraps
		await expect(hist).toBeFocused();
		await page.keyboard.press('ArrowLeft'); // wraps back
		await expect(rt).toBeFocused();
		await page.keyboard.press('Home');
		await expect(hist).toBeFocused();
		await page.keyboard.press('End');
		await expect(rt).toBeFocused();
		await expect(rt).toHaveAttribute('aria-selected', 'true');
	});

	test('a popup that opens late leaves focus where the person moved it', async ({ page }) => {
		let release = () => {};
		const held = new Promise<void>((r) => (release = r));
		await page.route('**/data/map.json', async (route) => {
			await held;
			await route.continue();
		});
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const tab = page.getByRole('tab', { name: 'Historical Comparison' });
		await tab.focus();

		release();
		await expect(mapRegion(page).getByRole('heading', { name: 'syt1', exact: true })).toBeVisible();
		await expect(tab).toBeFocused();
	});

	test('a popup opened from the search takes focus, as the keyboard route to its file pull-down', async ({ page }) => {
		await openNode(page, 'syt1', 'syt1 / SYN-SITE1');
		const map = mapRegion(page);
		await expect(map.getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
		await findNode(page, 'syr1');
		await expect(map.getByRole('heading', { name: 'syr1', exact: true })).toBeVisible();
		await expect(map.getByRole('combobox', { name: /View a file/ })).toBeFocused();
	});

	test('Tab reaches only the selected comparison tab', async ({ page }) => {
		await page.goto('/');
		const tabs = panel(page).getByRole('tab');
		await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
		await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
	});
});
