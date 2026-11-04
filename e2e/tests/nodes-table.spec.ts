import { chip, expect, mapRegion, panel, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

const count = (page: Page) => page.getByRole('main').getByRole('status');

test.describe('nodes table', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('nodes');
		await expect(page.getByRole('heading', { name: 'Nodes and ECs' })).toBeVisible();
	});

	test('starts on the nodes with an EC file', async ({ page }) => {
		// In the sample all but syf1 (flow series only) and syx1 (no files) have one.
		await expect(count(page)).toHaveText('7 of 9 nodes');
		await expect(page.getByRole('main').getByRole('row')).toHaveCount(8); // and the header
	});

	test('the filter off lists all 9', async ({ page }) => {
		await page.getByRole('checkbox', { name: 'Only nodes with an EC file available' }).uncheck();
		await expect(count(page)).toHaveText('9 of 9 nodes');
		await expect(page.getByRole('main').getByRole('row')).toHaveCount(10);
	});

	test('filters by basin and by search', async ({ page }) => {
		await page.getByRole('searchbox', { name: 'Search' }).fill('SYN-SITE1');
		await expect(count(page)).toHaveText('1 of 9 nodes');
		await expect(page.getByRole('button', { name: 'Show syt1 on the map' })).toBeVisible();
		await page.getByRole('searchbox', { name: 'Search' }).fill('');
		await page.getByRole('combobox', { name: /Basin/ }).selectOption('Gouritz');
		await expect(count(page)).toHaveText('4 of 9 nodes');
		await page.getByRole('searchbox', { name: 'Search' }).fill('no such node');
		await expect(page.getByText('No nodes match these filters.')).toBeVisible();
	});

	test('names the method in use on each row', async ({ page }) => {
		const search = page.getByRole('searchbox', { name: 'Search' });
		const row = (name: string) => page.getByRole('row', { name: new RegExp(`\\b${name}\\b`) });
		await search.fill('syt1');
		await expect(row('syt1')).toContainText('.tab');
		await search.fill('syr1');
		await expect(row('syr1')).toContainText('Revised .rul');
	});

	test('an EC chosen on a row reaches the panel', async ({ page }) => {
		await page.getByRole('combobox', { name: 'EC for syt1' }).selectOption('C');
		await page.getByRole('button', { name: 'Show syt1 on the map' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syt1 / SYN-SITE1');
		await expect(chip(page, 'EC in use')).toHaveText('EC in use C');
	});

	test('a row opens the map on that node', async ({ page }) => {
		await page.getByRole('cell', { name: 'SYN-SITE1' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syt1 / SYN-SITE1');
		await expect(mapRegion(page).getByRole('heading', { name: 'syt1', exact: true })).toBeVisible();
		await expect(mapRegion(page).getByText('syt1 / SYN-SITE1', { exact: true })).toBeVisible();
	});

	test('the filters survive a trip to the map and back', async ({ page }) => {
		await page.getByRole('checkbox', { name: 'Only nodes with an EC file available' }).uncheck();
		await expect(count(page)).toHaveText('9 of 9 nodes');
		await page.getByRole('link', { name: 'Map and compliance' }).click();
		await expect(page.getByRole('region', { name: 'Map of Water Management Areas' })).toBeVisible();
		await page.getByRole('link', { name: 'Nodes and ECs' }).click();
		await expect(count(page)).toHaveText('9 of 9 nodes');
	});
});
