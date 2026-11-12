import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, MAP, mapSettled, test, USER_API } from '../support/app.ts';
import type { Page, Request, TestInfo } from '@playwright/test';

// The admin import panel (#17, P4), on a made-up API that stands in for server/'s POST /api/nodes.
// Every node, file and value here is synthetic: invented codes (syx1, syy2, syw3) and runs. The KML
// and the folder are written by the spec, beside its results.

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/** A tiny Desktop .tab, as uploadMatch.test.ts makes them: each month's Total is `scale` + its index / 10. */
function tab(ec: string, scale: number): string {
	const row = (m: string, i: number) => {
		const t = (scale + i / 10).toFixed(3);
		return `         ${m}  ${t}  0.1  0.1  ${t}  ${(Number(t) / 2).toFixed(3)}  0.000  ${t}`;
	};
	return ['        Synthetic Desktop output, invented for the tests', `        Ecological Category = ${ec}`, '', '        Month  Natural  SD  CV  Maint.  Drought  High  Total', ...MONTHS.map(row), ''].join('\n');
}

const placemark = (code: string, lon: number, lat: number, river: string) => `
		<Placemark><name>${code}</name>
			<ExtendedData><SchemaData><SimpleData name="NODE">${code}</SimpleData><SimpleData name="RIVER">${river}</SimpleData></SchemaData></ExtendedData>
			<Point><coordinates>${lon},${lat},0</coordinates></Point>
		</Placemark>`;

/** syx1 and syy2 inside the stubbed Breede-Olifants (support/app.ts), syw3 outside it, and a line that is no point. */
const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder><name>Synthetic nodes</name>
${placemark('syx1', 21.1, -34.1, 'Test River')}
${placemark('syy2', 21.3, -33.9, 'Other Test River')}
${placemark('syw3', 25.5, -30.2, 'Far Test River')}
		<Placemark><name>A synthetic line</name><LineString><coordinates>21,-34 21.1,-34.1</coordinates></LineString></Placemark>
</Folder></Document></kml>`;

/**
 * The folder: two runs of syx1, the second a copy of the first under another EC (an EC decision);
 * a Revised run of syw3; a file for syy2 whose name matches no node; and a file that is no Desktop output.
 */
const FOLDER: Record<string, string> = {
	'syx1C.tab': tab('C', 1),
	'syx1D.tab': tab('C', 1),
	'syw3.rul(NEWFORM)': 'Synthetic Revised run',
	'SYY-2B.tab': tab('B', 2),
	'readme.doc': 'Not a Desktop output'
};

function write(info: TestInfo, kml = KML, folder = FOLDER) {
	const dir = info.outputPath('upload');
	mkdirSync(join(dir, 'runs'), { recursive: true });
	writeFileSync(join(dir, 'nodes.kml'), kml);
	for (const [name, text] of Object.entries(folder)) writeFileSync(join(dir, 'runs', name), text, 'latin1');
	return { kml: join(dir, 'nodes.kml'), folder: join(dir, 'runs'), files: Object.keys(folder).map((n) => join(dir, 'runs', n)) };
}

type Me = { id: string; email: string; admin: boolean };
const ADMIN: Me = { id: '00000000-0000-4000-8000-0000000000aa', email: 'admin@example.com', admin: true };
const MEMBER: Me = { id: '00000000-0000-4000-8000-0000000000bb', email: 'member@example.com', admin: false };

/** The API: who is signed in, and POST /api/nodes answering as server/ does, or with `nodes` when given. */
async function host(page: Page, me: Me, nodes?: (body: { node: { id: string } }) => { status: number; json: unknown }) {
	const calls: Request[] = [];
	await page.route(USER_API, (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
		const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'cache-control': 'no-store' } });
		if (path === 'me' || path === 'auth/refresh') return reply(me);
		if (path === 'nodes' && req.method() === 'POST') {
			calls.push(req);
			if (!me.admin) return reply({ error: 'Not found.' }, 404);
			const body = req.postDataJSON();
			if (nodes) {
				const r = nodes(body);
				return reply(r.json, r.status);
			}
			return reply({ wma: body.wma, id: body.node.id, nodes: calls.length, deleted: 0, updatedAt: '2026-11-12T09:00:00.000Z' });
		}
		return reply({ error: 'Not found.' }, 404);
	});
	return calls;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Import' });
const map = (page: Page) => page.getByRole('region', { name: 'Map of imported nodes' });
const nodesTable = (page: Page) => panel(page).getByRole('table', { name: 'Nodes' });
const row = (page: Page, code: string) => nodesTable(page).getByRole('row').filter({ has: page.getByRole('button', { name: code, exact: true }) });
const dialog = (page: Page) => page.getByRole('dialog');

/** As an admin: open the panel from the app bar, choose the WMA, load the KML and the folder. */
async function load(page: Page, info: TestInfo, kml = KML, folder = FOLDER) {
	const paths = write(info, kml, folder);
	await page.goto(MAP);
	await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Import', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Import nodes' })).toBeVisible();
	await panel(page).getByLabel('Water Management Area').selectOption({ label: 'Breede-Olifants' });
	await panel(page).getByLabel('Load node KML').setInputFiles(paths.kml);
	await panel(page).getByLabel('Load EWR files from a folder').setInputFiles(paths.folder);
	return paths;
}

test.describe('node import', () => {
	test('a copy with no user list offers no import, and says so if it is opened', async ({ page }) => {
		await page.goto(MAP);
		await expect(page.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
		await page.goto('import/');
		await expect(page.getByText('This copy of the site has no user list, so nothing can be saved here.')).toBeVisible();
		await expect(page.getByLabel('Load node KML')).toHaveCount(0);
	});

	test('a user who is not an admin has no link to it, and the page says only admins can', async ({ page }) => {
		await host(page, MEMBER);
		await page.goto(MAP);
		await expect(page.getByText('Signed in as member@example.com')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
		await page.goto('import/');
		await expect(page.getByText('Only an admin can import nodes')).toBeVisible();
		await expect(page.getByLabel('Load node KML')).toHaveCount(0);
	});

	test('matches the folder to the KML as it loads, and flags a node with no data and one outside the WMA', async ({ page }, info) => {
		await host(page, ADMIN);
		await load(page, info);
		const p = panel(page);
		await expect(p.getByText('nodes.kml: 3 placemarks read, 1 skipped, 3 nodes.')).toBeVisible();
		await expect(p.getByText('5 files read and matched: 3 joined a node, 2 did not.')).toBeVisible();
		await expect(p.getByLabel('Basin')).toHaveValue('Berg');

		await expect(row(page, 'syx1')).toContainText('syx1C.tab · C');
		await expect(row(page, 'syx1')).toContainText('syx1D.tab · C');
		await expect(row(page, 'syx1')).toContainText('ECs C');
		await expect(row(page, 'syy2')).toContainText("No data matches this node's name");
		await expect(row(page, 'syw3')).toContainText('ECs A, A/B, B, B/C, C, C/D, D');
		await expect(row(page, 'syw3')).toContainText('Outside the WMA');
		await expect(p.getByRole('alert').filter({ hasText: 'One node is outside the outline of Breede-Olifants' })).toBeVisible();

		const unmatched = p.getByRole('table', { name: /^Unmatched files/ });
		await expect(unmatched.getByRole('row').filter({ hasText: 'SYY-2B.tab' })).toContainText('No node: File name does not match a node code in the KML.Yes');
		await expect(unmatched.getByRole('row').filter({ hasText: 'readme.doc' })).toContainText('No');
		await expect(p.getByRole('table', { name: /^EC decisions/ }).getByRole('row').filter({ hasText: 'syx1D.tab' })).toContainText('Copy of the header’s run');
		await expect(p.getByRole('table', { name: /^KML points skipped/ })).toContainText('A synthetic line');

		await p.getByLabel('Show').selectOption('nodata');
		await expect(nodesTable(page).getByRole('button')).toHaveText(['syy2']);
		await mapSettled(map(page));
	});

	test('attaches a file to a node with no data, overrides an EC, and saves node by node', async ({ page }, info) => {
		const calls = await host(page, ADMIN);
		await load(page, info);
		await row(page, 'syy2').getByRole('button', { name: 'syy2' }).click();
		const d = dialog(page);
		await expect(d.getByRole('heading', { name: 'Node syy2' })).toBeVisible();
		await expect(d.getByText("No data matches this node's name.")).toBeVisible();
		await d.getByLabel('Unmatched file').selectOption('SYY-2B.tab');
		await d.getByRole('button', { name: 'Attach' }).click();
		await expect(d.getByRole('status')).toHaveText('Attached SYY-2B.tab to syy2.');
		await expect(d.getByRole('status')).toBeFocused();
		await expect(d.getByRole('table', { name: 'Files of syy2' })).toContainText('Attached by an admin.');
		await expect(d.getByText('No unmatched files to attach.')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(d).toHaveCount(0);
		await expect(row(page, 'syy2')).toContainText('ECs B');

		const decisions = panel(page).getByRole('table', { name: /^EC decisions/ });
		await decisions.getByLabel('EC used for syx1D.tab').selectOption('D');
		await expect(decisions.getByRole('row').filter({ hasText: 'syx1D.tab' })).toContainText('Set by an admin');
		await expect(row(page, 'syx1')).toContainText('ECs C, D');

		expect(calls).toHaveLength(0);
		await panel(page).getByRole('button', { name: 'Save 3 nodes to Breede-Olifants' }).click();
		await expect(panel(page).getByText('Every node of this import is saved.')).toBeVisible();
		await expect(panel(page).getByText('Saved 3 of 3.')).toBeVisible();

		const bodies = calls.map((c) => c.postDataJSON());
		for (const c of calls) expect(c.headers()['x-requested-with']).toBe('XMLHttpRequest');
		expect(bodies.map((b) => [b.wma, b.node.id, b.node.basin, Object.keys(b.texts)])).toEqual([
			['breede-olifants', 'breede-olifants:syx1', 'Berg', ['syx1C.tab', 'syx1D.tab']],
			['breede-olifants', 'breede-olifants:syy2', 'Berg', ['SYY-2B.tab']],
			['breede-olifants', 'breede-olifants:syw3', 'Berg', ['syw3.rul(NEWFORM)']]
		]);
		expect(bodies[0].node.files[1]).toEqual({ name: 'syx1D.tab', kind: 'tab', ec: 'D', basis: '', ecNote: 'Set by an admin: treated as D, where the file name says D and the header says C' });
		expect(bodies[1].node.files).toEqual([{ name: 'SYY-2B.tab', kind: 'tab', ec: 'B', basis: '', ecNote: 'Attached by an admin.' }]);
		expect(bodies[1].node.ecsAvailable).toEqual(['B']);
		expect(bodies[1].texts['SYY-2B.tab']).toBe(tab('B', 2));
	});

	test('leaves the nodes with no data out of a save when asked', async ({ page }, info) => {
		const calls = await host(page, ADMIN);
		await load(page, info);
		await panel(page).getByLabel('Also save the 1 node with no data, as locations only').uncheck();
		await panel(page).getByRole('button', { name: 'Save 2 nodes to Breede-Olifants' }).click();
		await expect(panel(page).getByText('Saved 2 of 2.')).toBeVisible();
		expect(calls.map((c) => c.postDataJSON().node.id)).toEqual(['breede-olifants:syx1', 'breede-olifants:syw3']);
	});

	test('a server that is not ready stops the save and says so; a refused node is listed and sent again', async ({ page }, info) => {
		let ready = false;
		const calls = await host(page, ADMIN, (b) =>
			!ready
				? { status: 503, json: { error: 'Sign-in is not set up yet. Try again later.' } }
				: b.node.id.endsWith('syy2')
					? { status: 409, json: { error: 'Another admin changed this WMA at the same time. Reload and try again.' } }
					: { status: 200, json: { wma: 'breede-olifants', id: b.node.id, nodes: 1, deleted: 0, updatedAt: '2026-11-12T09:00:00.000Z' } }
		);
		await load(page, info);
		const save = panel(page).getByRole('button', { name: /^Save \d nodes? to Breede-Olifants$/ });
		await save.click();
		await expect(panel(page).getByRole('alert').filter({ hasText: 'The site cannot store nodes yet: the server is not ready (HTTP 503).' })).toContainText(
			'The server said: Sign-in is not set up yet. Try again later.'
		);
		expect(calls).toHaveLength(1);

		ready = true;
		await save.click();
		await expect(panel(page).getByText('Saved 2 of 3.')).toBeVisible();
		await expect(panel(page).getByRole('alert').filter({ hasText: 'Not saved:' })).toContainText('syy2: Another admin changed this WMA at the same time.');
		await expect(save).toHaveText('Save 1 node to Breede-Olifants');
	});

	test('a node on the map opens its panel, and the map draws one with no data apart', async ({ page }, info) => {
		await host(page, ADMIN);
		// One node, so the map centres on it.
		await load(page, info, KML.replace(/<Placemark><name>sy[xw].*?<\/Placemark>/gs, ''), { 'readme.doc': 'Not a Desktop output' });
		await expect(nodesTable(page).getByRole('button')).toHaveText(['syy2']);
		await expect(map(page).getByText('Node with no data')).toBeVisible();
		await mapSettled(map(page));
		const box = (await map(page).locator('canvas.maplibregl-canvas').boundingBox())!;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await expect(dialog(page).getByRole('heading', { name: 'Node syy2' })).toBeVisible();
	});

	test('a file that is not KML is refused, saying why', async ({ page }, info) => {
		await host(page, ADMIN);
		const paths = write(info, '<html><body>Not KML</body></html>');
		await page.goto('import/');
		await panel(page).getByLabel('Water Management Area').selectOption({ label: 'Breede-Olifants' });
		await panel(page).getByLabel('Load node KML').setInputFiles(paths.kml);
		await expect(panel(page).getByRole('alert')).toHaveText('Could not read nodes.kml: This is not a KML file: its root element is <html>, not <kml>.');
		await expect(panel(page).getByLabel('Load EWR files from a folder')).toBeDisabled();
	});
});
