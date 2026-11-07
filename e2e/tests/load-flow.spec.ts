import { expect, fixture, historical, MAP, openNode, panel, realTime, sourceInUse, test } from '../support/app.ts';
import type { Page } from '@playwright/test';

// The Load flow data window: the same importers as each comparison's Data source, in a window of their own.
// The read messages are the ones historical.spec.ts and real-time.spec.ts pin for these fixtures.
const XLSX_READ = 'monthly.xlsx. Read 179 months, Oct 2005 to Sep 2020, with 1 missing. Layout: year rows by month columns.';
const CSV_READ = 'readings-12min.csv. Read 360 readings, 2025-11-29 to 2025-12-01.';

const window_ = (page: Page) => page.getByRole('dialog', { name: 'Load flow data' });

async function openWindow(page: Page) {
	await panel(page).getByRole('button', { name: 'Load flow data…' }).click();
	await expect(window_(page)).toBeVisible();
	return window_(page);
}

test.describe('the Load flow data window', () => {
	test('loads monthly flow into the Historical Comparison, which shows it', async ({ page }) => {
		await page.goto(MAP);
		const w = await openWindow(page);
		await w.getByLabel('Choose a monthly flow file').setInputFiles(fixture('monthly.xlsx'));
		await expect(w.getByRole('status')).toHaveText(XLSX_READ);
		await w.getByRole('button', { name: 'Show in the Historical Comparison' }).click();
		await expect(w).toBeHidden();
		await expect(page.getByRole('tab', { name: 'Historical Comparison' })).toHaveAttribute('aria-selected', 'true');
		const hist = historical(page);
		await expect(sourceInUse(hist)).toHaveValue('sheet');
		await expect(hist.getByRole('status').first()).toHaveText(XLSX_READ);
	});

	test('says where 12-minute readings stop, under that kind only', async ({ page }) => {
		await page.goto(MAP);
		const w = await openWindow(page);
		const note = /12-minute readings for about the last month only/;
		await expect(w.getByRole('region', { name: '12-minute or daily flow for the Real Time Comparison' })).toContainText(note);
		await expect(w.getByRole('region', { name: 'Monthly flow for the Historical Comparison' })).not.toContainText(note);
	});

	test('loads 12-minute readings into the Real Time Comparison, in place of a linked gauge', async ({ page }) => {
		// syq1 opens on its gauge, X0H999.
		await openNode(page, 'syq1');
		await page.getByRole('tab', { name: 'Real Time Comparison' }).click();
		await expect(sourceInUse(realTime(page))).toHaveValue('gauge');

		const w = await openWindow(page);
		await w.getByLabel('Choose a 12-minute or daily flow file').setInputFiles(fixture('readings-12min.csv'));
		await expect(w.getByRole('status')).toHaveText(CSV_READ);
		await w.getByRole('button', { name: 'Show in the Real Time Comparison' }).click();
		const rt = realTime(page);
		await expect(sourceInUse(rt)).toHaveValue('text');
		await expect(rt.getByRole('status').first()).toHaveText(CSV_READ);
	});

	test('takes a dropped file', async ({ page }) => {
		await page.goto(MAP);
		const w = await openWindow(page);
		const text = 'Date,Time,Flow (m3/s)\n2025-11-29,00:00:00,1\n2025-11-29,00:12:00,3\n';
		const data = await page.evaluateHandle((body) => {
			const dt = new DataTransfer();
			dt.items.add(new File([body], 'dropped.csv', { type: 'text/csv' }));
			return dt;
		}, text);
		await w.getByRole('group', { name: '12-minute or daily flow file' }).dispatchEvent('drop', { dataTransfer: data });
		await expect(w.getByRole('status')).toHaveText('dropped.csv. Read 2 readings, 2025-11-29 to 2025-11-29.');
	});

	test('says when a file holds no flow, and offers nothing to show', async ({ page }) => {
		await page.goto(MAP);
		const w = await openWindow(page);
		await w.getByLabel('Choose a monthly flow file').setInputFiles(fixture('junk.txt'));
		await expect(w.getByRole('alert')).toHaveText(
			'junk.txt. No flow table found in "junk.txt". Expected a row of month names above year rows, or Date and Flow columns.'
		);
		await expect(w.getByRole('button', { name: /^Show in/ })).toHaveCount(0);
	});

	test('closes with Escape or its button, and opens again on what is loaded', async ({ page }) => {
		await page.goto(MAP);
		let w = await openWindow(page);
		await page.keyboard.press('Escape');
		await expect(w).toBeHidden();
		w = await openWindow(page);
		await w.getByLabel('Choose a monthly flow file').setInputFiles(fixture('monthly.xlsx'));
		await w.getByRole('button', { name: 'Close' }).click();
		await expect(w).toBeHidden();
		w = await openWindow(page);
		await expect(w.getByRole('status')).toHaveText(XLSX_READ);
	});
});
