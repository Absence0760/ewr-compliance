import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';
import { expect, expectRow, findNode, historical, MAP, mapRegion, mapSettled, panel, select, serveNodeStore, test, USER_API } from '../support/app.ts';

// The node store (#17, P5): nodes added on the site, merged over the sample, on a made-up store and API.
// Every node, file and value here is synthetic: invented codes (syu1, syv1, syz7) and runs.
//
// syu1's run is tab('C', 1): each month's Total Flows Maint. is 1 + its index / 10 Mm³, and its Low Flows
// Drought half that. Nov is 1.100 Mm³ and 0.550 Mm³; m³/s is Mm³ × 10⁶ ÷ (30 × 86 400), so ÷ 2.592:
//   EWR Monthly Requirement 0.424, Drought EWR 0.212, Urgent action required (90%) 0.382.

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
function tab(ec: string, scale: number): string {
	const row = (m: string, i: number) => {
		const t = (scale + i / 10).toFixed(3);
		return `         ${m}  ${t}  0.1  0.1  ${t}  ${(Number(t) / 2).toFixed(3)}  0.000  ${t}`;
	};
	return ['        Synthetic Desktop output, invented for the tests', `        Ecological Category = ${ec}`, '', '        Month  Natural  SD  CV  Maint.  Drought  High  Total', ...MONTHS.map(row), ''].join('\n');
}

const AT = '2026-11-12T09:00:00.000Z';
const node = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	label: id.split(':')[1],
	basin: 'Gouritz',
	river: 'Uploaded Test River',
	quat: 'Z80D',
	lon: 21.1,
	lat: -33.9,
	tec: 'C',
	files: [],
	...extra
});
const SYU1 = node('breede-olifants:syu1', { files: [{ name: 'syu1C.tab', kind: 'tab', ec: 'C', basis: '' }] });
const SYV1 = node('vaal-orange:syv1', { basin: 'Sample Basin', lon: 26, lat: -29 });
const wmaFile = (wma: string, nodes: unknown[], deleted: string[] = []) => ({ version: 1, wma, updatedAt: AT, nodes, deleted });
const indexOf = (files: Record<string, { nodes: unknown[]; deleted: string[] }>) => ({
	version: 1,
	wmas: Object.fromEntries(Object.entries(files).map(([w, f]) => [w, { updatedAt: AT, nodes: f.nodes.length, deleted: f.deleted.length }]))
});

/** A store that changes as the API writes it: the WMA files by slug, and each node's texts by id. */
function store(wmas: Record<string, { nodes: { id: string }[]; deleted: string[] }>, texts: Record<string, unknown>) {
	let n = 0;
	return {
		wmas,
		texts,
		/** Every write moves updatedAt, as the API's does. */
		touch() {
			n++;
		},
		serve(path: string): unknown {
			const stamp = `2026-11-12T09:${String(n).padStart(2, '0')}:00.000Z`;
			if (path === 'index.json') return { version: 1, wmas: Object.fromEntries(Object.entries(wmas).map(([w, f]) => [w, { updatedAt: stamp, nodes: f.nodes.length, deleted: f.deleted.length }])) };
			const wma = /^wma-(.+)\.json$/.exec(path)?.[1];
			if (wma) return wmas[wma] ? { version: 1, wma, updatedAt: stamp, ...wmas[wma] } : undefined;
			const key = /^files\/([a-z-]+)\/(.+)\.json$/.exec(path);
			return key ? texts[`${key[1]}:${key[2]}`] : undefined;
		}
	};
}

const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'admin@example.com', admin: true };

/** The API as an admin sees it: /api/me, and the node writes, answered by `reply` (the store changed there). */
async function api(page: Page, reply: (path: string, body: Record<string, unknown>) => { status: number; json: unknown }) {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	await page.route(USER_API, (route) => {
		const req: Request = route.request();
		const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
		if (path === 'me' || path === 'auth/refresh') return route.fulfill({ json: ADMIN });
		if (path.startsWith('nodes') && req.method() === 'POST') {
			const body = req.postDataJSON() as Record<string, unknown>;
			calls.push({ path, body });
			const r = reply(path, body);
			return route.fulfill({ status: r.status, json: r.json });
		}
		return route.fulfill({ status: 404, json: { error: 'Not found.' } });
	});
	return calls;
}

const change = (wma: string, id: string) => ({ status: 200, json: { wma, id, nodes: 1, deleted: 0, updatedAt: AT } });
const nodesTable = (page: Page) => page.getByRole('table');
const nodeRow = (page: Page, label: string) => nodesTable(page).getByRole('row').filter({ has: page.getByRole('button', { name: `Show ${label} on the map` }) });

test.describe('node store', () => {
	test('with no store (a 404), the app is the built-in data and says nothing', async ({ page }) => {
		await page.goto('nodes/');
		await page.getByLabel('Only nodes with an EC file available').uncheck();
		await expect(page.getByText('9 of 9 nodes')).toBeVisible();
		await expect(page.getByText('Added on the site')).toHaveCount(0);
		await expect(page.getByText(/could not be read/)).toHaveCount(0);
		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		await expect(page.getByRole('button', { name: 'Add node' })).toHaveCount(0);
		await expect(page.getByText(/could not be read/)).toHaveCount(0);
	});

	test('everyone sees uploaded nodes, marked, with lines from the same code, and a deleted node hidden; no admin controls', async ({ page }) => {
		const files = { 'breede-olifants': wmaFile('breede-olifants', [SYU1], ['Berg:syb1']), 'vaal-orange': wmaFile('vaal-orange', [SYV1]) };
		await serveNodeStore(page, {
			'index.json': indexOf(files),
			'wma-breede-olifants.json': files['breede-olifants'],
			'wma-vaal-orange.json': files['vaal-orange'],
			'files/breede-olifants/syu1.json': { 'syu1C.tab': tab('C', 1) }
		});

		await page.goto('/');
		const wmas = page.getByRole('navigation', { name: 'Water Management Areas' });
		await expect(wmas.getByRole('link', { name: /Vaal-Orange/ })).toContainText('1 EWR node');
		// Nine built in, syb1 hidden, syu1 added.
		await expect(wmas.getByRole('link', { name: /Breede-Olifants/ })).toContainText('9 EWR nodes');

		await page.goto('nodes/');
		await page.getByLabel('Only nodes with an EC file available').uncheck();
		await expect(page.getByText('10 of 10 nodes')).toBeVisible();
		await expect(nodeRow(page, 'syu1')).toContainText('Added on the site');
		await expect(nodeRow(page, 'syv1')).toContainText('Added on the site');
		await expect(nodeRow(page, 'syb1')).toHaveCount(0);
		await expect(nodeRow(page, 'syt1')).not.toContainText('Added on the site');

		// From the table to its own WMA's map, whatever its basin says.
		await nodeRow(page, 'syv1').getByRole('button').click();
		await expect(page).toHaveURL(/wma\/vaal-orange\/$/);
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syv1');
		await expect(panel(page).getByText('Added on the site')).toBeVisible();

		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		await findNode(page, 'syu1');
		await expect(panel(page).getByText('Added on the site')).toBeVisible();
		await expectRow(historical(page).getByRole('table'), 'Nov', { 'EWR Monthly Requirement': '0.424', 'Urgent action required': '0.382', 'Drought EWR': '0.212' });
		const popup = mapRegion(page).locator('.maplibregl-popup');
		await expect(popup).toContainText('Added on the site');

		await expect(page.getByRole('button', { name: 'Add node' })).toHaveCount(0);
		await expect(page.getByText(/Deleted nodes/)).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Delete node/ })).toHaveCount(0);
	});

	test('a WMA file that fails its check is left out and said once; the rest and the built-in data are intact', async ({ page }) => {
		const good = wmaFile('breede-olifants', [SYU1]);
		await serveNodeStore(page, {
			'index.json': indexOf({ 'breede-olifants': good, 'vaal-orange': wmaFile('vaal-orange', [SYV1]) }),
			'wma-breede-olifants.json': good,
			'wma-vaal-orange.json': { version: 2, wma: 'vaal-orange' }
		});
		await page.goto('nodes/');
		await page.getByLabel('Only nodes with an EC file available').uncheck();
		await expect(page.getByRole('status').filter({ hasText: 'Nodes added on the site could not be read for Vaal-Orange' })).toBeVisible();
		await expect(page.getByText('10 of 10 nodes')).toBeVisible();
		await expect(nodeRow(page, 'syu1')).toBeVisible();
		await expect(nodeRow(page, 'syv1')).toHaveCount(0);
		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		await expect(mapRegion(page).getByRole('status').filter({ hasText: 'could not be read for Vaal-Orange' })).toBeVisible();
	});

	test('an index that cannot be read leaves the built-in data, and says so', async ({ page }) => {
		await serveNodeStore(page, { 'index.json': 500 });
		await page.goto('nodes/');
		await page.getByLabel('Only nodes with an EC file available').uncheck();
		await expect(page.getByText('Nodes added on the site could not be read (HTTP 500). The built-in nodes are shown.')).toBeVisible();
		await expect(page.getByText('9 of 9 nodes')).toBeVisible();
	});

	test('a file the store has no text for is shown as unreadable, never drawn', async ({ page }) => {
		const two = node('breede-olifants:syu1', { files: [{ name: 'syu1C.tab', kind: 'tab', ec: 'C', basis: '' }, { name: 'syu1D.tab', kind: 'tab', ec: 'D', basis: '' }] });
		const f = wmaFile('breede-olifants', [two]);
		await serveNodeStore(page, {
			'index.json': indexOf({ 'breede-olifants': f }),
			'wma-breede-olifants.json': f,
			// Written a write behind the listing: D is missing, and an old file is still there.
			'files/breede-olifants/syu1.json': { 'syu1C.tab': tab('C', 1), 'syu1B.tab': tab('B', 3) }
		});
		await page.goto(MAP);
		await findNode(page, 'syu1');
		await expect(panel(page).getByText('The node store has no text for syu1D.tab, so it cannot be read.')).toBeVisible();
		await expectRow(historical(page).getByRole('table'), 'Nov', { 'EWR Monthly Requirement': '0.424' });

		await select(panel(page), /View file/).selectOption('syu1D.tab');
		const viewer = page.getByRole('dialog', { name: 'Files for syu1' });
		await expect(viewer.getByRole('alert')).toContainText('syu1D.tab is listed for syu1, but the node store has no text for it');

		// Choosing EC D, the missing file, draws nothing rather than a wrong line.
		await page.keyboard.press('Escape');
		await select(panel(page), /Ecological Category/).selectOption('D');
		await expect(panel(page).locator('.notice.error')).toContainText('syu1D.tab is listed for syu1, but the node store has no text for it');
		await expect(historical(page).getByRole('table')).toHaveCount(0);
	});

	test('an admin restores a deleted built-in node', async ({ page }) => {
		const s = store({ 'breede-olifants': { nodes: [], deleted: ['Berg:syb1'] } }, {});
		await serveNodeStore(page, (p) => s.serve(p));
		const calls = await api(page, (path, body) => {
			s.wmas['breede-olifants'].deleted = [];
			s.touch();
			return change(body.wma as string, body.id as string);
		});
		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		const deleted = page.getByText('Deleted nodes (1)');
		await deleted.click();
		await page.getByRole('button', { name: 'Restore syb1' }).click();
		await expect(mapRegion(page).getByRole('status').filter({ hasText: 'Restored syb1.' })).toBeVisible();
		expect(calls).toEqual([{ path: 'nodes/restore', body: { wma: 'breede-olifants', id: 'Berg:syb1' } }]);
		await expect(page.getByText(/Deleted nodes/)).toHaveCount(0);
		await findNode(page, 'syb1');
	});

	test('an admin deletes an uploaded node, after a confirmation naming it', async ({ page }) => {
		const s = store({ 'breede-olifants': { nodes: [SYU1], deleted: [] } }, { 'breede-olifants:syu1': { 'syu1C.tab': tab('C', 1) } });
		await serveNodeStore(page, (p) => s.serve(p));
		const calls = await api(page, (path, body) => {
			s.wmas['breede-olifants'].nodes = [];
			s.touch();
			return { status: 200, json: { ...change(body.wma as string, body.id as string).json, tombstone: false } };
		});
		await page.goto(MAP);
		await findNode(page, 'syu1');
		await panel(page).getByRole('button', { name: 'Delete node…' }).click();
		const confirm = page.getByRole('dialog', { name: 'Delete node syu1?' });
		await expect(confirm).toContainText('syu1 was added on the site. Deleting it removes it and its files for everyone.');
		await confirm.getByRole('button', { name: 'Cancel' }).click();
		await expect(confirm).toBeHidden();
		expect(calls).toEqual([]);

		await panel(page).getByRole('button', { name: 'Delete node…' }).click();
		await confirm.getByRole('button', { name: 'Delete syu1' }).click();
		await expect(confirm).toBeHidden();
		expect(calls).toEqual([{ path: 'nodes/delete', body: { wma: 'breede-olifants', id: 'breede-olifants:syu1' } }]);
		await expect(mapRegion(page).getByRole('status').filter({ hasText: 'Deleted syu1.' })).toBeVisible();
		await expect(panel(page).getByRole('heading', { name: 'Select a node on the map' })).toBeVisible();
		const search = page.getByRole('combobox', { name: 'Find a node or site' });
		await search.fill('syu1');
		await search.press('Enter');
		await expect(page.getByText('No node or site called syu1')).toBeVisible();
	});

	test('a refused delete says why, and keeps the node', async ({ page }) => {
		const s = store({ 'breede-olifants': { nodes: [SYU1], deleted: [] } }, {});
		await serveNodeStore(page, (p) => s.serve(p));
		await api(page, () => ({ status: 503, json: { error: 'The node store is not set up.' } }));
		await page.goto(MAP);
		await findNode(page, 'syu1');
		await panel(page).getByRole('button', { name: 'Delete node…' }).click();
		const confirm = page.getByRole('dialog', { name: 'Delete node syu1?' });
		await confirm.getByRole('button', { name: 'Delete syu1' }).click();
		await expect(confirm.getByRole('alert')).toHaveText(
			'The site cannot store nodes yet: the server is not ready (HTTP 503). The server said: The node store is not set up.'
		);
		await confirm.getByRole('button', { name: 'Cancel' }).click();
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('syu1');
	});

	test('an admin adds a node on the map, with its files, and it is saved as the import would save it', async ({ page }, info) => {
		const s = store({}, {});
		await serveNodeStore(page, (p) => s.serve(p));
		const calls = await api(page, (path, body) => {
			const n = body.node as { id: string };
			s.wmas['breede-olifants'] = { nodes: [n], deleted: [] };
			s.texts[n.id] = body.texts;
			s.touch();
			return change('breede-olifants', n.id);
		});
		const dir = info.outputPath('runs');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'syz7C.tab'), tab('C', 1), 'latin1');
		writeFileSync(join(dir, 'other-run.tab'), tab('D', 2), 'latin1');

		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		await page.getByRole('button', { name: 'Add node' }).click();
		await expect(page.getByRole('button', { name: 'Add node' })).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByText('Click the map where the new node is.')).toBeVisible();
		await mapRegion(page).locator('canvas').click({ position: { x: 300, y: 250 } });

		const form = page.getByRole('dialog', { name: 'Add a node to Breede-Olifants' });
		await expect(form.getByLabel('Longitude')).not.toHaveValue('');
		await form.getByLabel('Node code (required)').fill('SYZ7');
		await expect(form.getByText('Saved as breede-olifants:syz7.')).toBeVisible();
		await form.getByLabel('River').fill('Added Test River');
		await form.getByLabel('TEC').selectOption('C');
		await form.getByLabel(/EWR files/).setInputFiles([join(dir, 'syz7C.tab'), join(dir, 'other-run.tab')]);
		const files = form.getByRole('table', { name: 'Files for the new node' });
		await expect(files.getByRole('row').filter({ hasText: 'other-run.tab' })).toContainText('Attached by an admin.');
		await expect(form.getByText('ECs with an EWR: C, D')).toBeVisible();
		await form.getByRole('button', { name: 'Save node to Breede-Olifants' }).click();
		await expect(form).toBeHidden();

		expect(calls).toHaveLength(1);
		const body = calls[0].body as { wma: string; node: Record<string, unknown>; texts: Record<string, string> };
		expect(body.wma).toBe('breede-olifants');
		expect(body.node).toMatchObject({ id: 'breede-olifants:syz7', label: 'SYZ7', basin: 'Berg', river: 'Added Test River', tec: 'C', ecsAvailable: ['C', 'D'] });
		expect(typeof body.node.lon).toBe('number');
		expect(typeof body.node.lat).toBe('number');
		expect((body.node.files as { name: string }[]).map((f) => f.name)).toEqual(['other-run.tab', 'syz7C.tab']);
		expect(Object.keys(body.texts).sort()).toEqual(['other-run.tab', 'syz7C.tab']);

		// Read back from the store, opened, with its lines drawn as any node's.
		await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('SYZ7');
		await expect(panel(page).getByText('Added on the site')).toBeVisible();
		await expectRow(historical(page).getByRole('table'), 'Nov', { 'EWR Monthly Requirement': '0.424' });
		await expect(mapRegion(page).getByRole('status').filter({ hasText: 'Saved SYZ7 to Breede-Olifants.' })).toBeVisible();
	});

	test('an add the API refuses says why, and the form stays', async ({ page }) => {
		await serveNodeStore(page, {});
		await api(page, () => ({ status: 409, json: { error: 'Another admin changed this WMA at the same time. Reload and try again.' } }));
		await page.goto(MAP);
		await mapSettled(mapRegion(page));
		await page.getByRole('button', { name: 'Add node' }).click();
		await page.getByRole('button', { name: 'Type coordinates instead' }).click();
		const form = page.getByRole('dialog', { name: 'Add a node to Breede-Olifants' });
		const save = form.getByRole('button', { name: 'Save node to Breede-Olifants' });
		await form.getByLabel('Node code (required)').fill('syz8');
		await expect(save).toBeDisabled();
		await form.getByLabel('Longitude').fill('21.05');
		await form.getByLabel('Latitude').fill('-33.95');
		await save.click();
		await expect(form.getByRole('alert')).toContainText('Not done (HTTP 409): another change got there first, or the WMA is full.');
		await expect(form).toBeVisible();
	});
});
