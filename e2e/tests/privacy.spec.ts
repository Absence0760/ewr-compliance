import { test as unwatched } from '@playwright/test';
import { expect, MAP, test } from '../support/app.ts';

// The notice is static/data/privacy.md: here the made-up one e2e/fixtures/make-sample-data.mjs writes.
test.describe('privacy notice', () => {
	test('is linked from the bar of every page', async ({ page }) => {
		for (const path of ['', MAP, 'nodes/', 'notes/']) {
			await page.goto(path);
			const link = page.getByRole('banner').getByRole('link', { name: 'Privacy notice' });
			await expect(link).toBeVisible();
		}
		await page.getByRole('banner').getByRole('link', { name: 'Privacy notice' }).click();
		await expect(page).toHaveURL(/\/privacy\/$/);
		await expect(page.getByRole('banner').getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('aria-current', 'page');
	});

	test('shows the notice from the data, as headings, lists and safe links', async ({ page }) => {
		await page.goto('privacy/');
		await expect(page).toHaveTitle('Privacy notice · EWR Compliance Measurement');
		const main = page.getByRole('main');
		await expect(main.getByRole('heading', { level: 2, name: 'Privacy notice (sample)' })).toBeVisible();
		await expect(main.getByRole('heading', { level: 3, name: 'What is kept' })).toBeVisible();
		await expect(main.getByText('synthetic', { exact: true })).toHaveJSProperty('tagName', 'STRONG');
		await expect(main.getByRole('listitem')).toHaveCount(4);
		await expect(main.getByRole('listitem').nth(1)).toHaveText('A made-up record of changes, kept for a made-up period.');
		await expect(main.getByRole('link', { name: 'the sample operator' })).toHaveAttribute('href', 'mailto:operator@example.com');
		await expect(main.getByRole('link', { name: "the sample regulator's page" })).toHaveAttribute('href', 'https://example.com/regulator');
	});
});

// Not watched: the data failing to load is the point, and the watch fails any test that sees a 500.
unwatched('the notice shows even when the data cannot load', async ({ page }) => {
	await page.route(/\/data\/index\.json$/, (route) => route.fulfill({ status: 500, body: 'down' }));
	await page.route(/\/api\/(me|users)/, (route) => route.fulfill({ status: 404, body: 'Not found' }));
	await page.goto('privacy/');
	await expect(page.getByRole('heading', { name: 'Privacy notice (sample)' })).toBeVisible();
	await page.goto('nodes/');
	await expect(page.getByText('Could not start: index.json: HTTP 500')).toBeVisible();
});
