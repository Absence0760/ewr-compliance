// Checks the three live ArcGIS layers against what the app assumes of them, using the app's own
// queries. e2e stubs these services, so this is the only thing that ever calls the real ones.
// Run with `node tools/check-live-services.ts`: exits 1 on a violation. It keeps no copy of the
// data: DWS supplies it without distribution rights (NOTICE.md), so print only counts, and write nothing.
import { readFileSync } from 'node:fs';
import type { FeatureCollection, Position } from 'geojson';
import { basinUrl, gaugeUrl, getAll, loadBasins, loadGauges, loadQuaternaries, quaternaryUrl } from '../src/lib/components/map/catchments.ts';

const BASINS = ['Berg', 'Breede', 'Gouritz', 'Olifants/Doorn'];
/** Drainage regions of the study area, by the first letter of a station number. Each must have a gauge. */
const REGIONS = ['E', 'G', 'H', 'J', 'K'];
const STATUSES = ['Active Weirs', 'Inactive Weirs'];
/** Generous box around the study area. A point outside it means swapped axes or the wrong datum. */
const LON = [16, 25];
const LAT = [-36, -29];

const violations: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) violations.push(what);
};

async function json(url: URL | string) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	return res.json();
}

/** The same query as `url`, changed by `set`. */
function variant(url: string, set: Record<string, string>): URL {
	const u = new URL(url);
	for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
	return u;
}

async function count(url: string): Promise<number> {
	const u = new URL(url);
	const answer = await json(`${u.origin}${u.pathname}?${new URLSearchParams({ where: u.searchParams.get('where')!, returnCountOnly: 'true', f: 'json' })}`);
	return answer.count;
}

/** The layer has the fields the app reads and filters on, and can page. */
async function checkLayer(url: string, fields: string[]) {
	const u = new URL(url);
	const layer = await json(`${u.origin}${u.pathname.replace(/\/query$/, '')}?f=json`);
	const have = new Set(layer.fields.map((f: { name: string }) => f.name));
	check(fields.every((f) => have.has(f)), `has fields ${fields.join(', ')}`);
	check(layer.advancedQueryCapabilities?.supportsPagination === true, 'supports paging');
	console.log(`  info maxRecordCount ${layer.maxRecordCount}`);
}

/** The app's request for one layer: everything arrived, in a size and time worth knowing. */
async function checkLoad(url: string, load: () => Promise<FeatureCollection>): Promise<FeatureCollection> {
	const start = performance.now();
	const fc = await load();
	const seconds = ((performance.now() - start) / 1000).toFixed(2);
	const res = await fetch(url);
	const bytes = (await res.arrayBuffer()).byteLength;
	const expected = await count(url);
	check(fc.features.length === expected, `all features arrived: ${fc.features.length} of ${expected}`);
	console.log(`  info ${bytes} bytes unzipped, ${seconds} s`);
	return fc;
}

const inBox = ([x, y]: Position) => x >= LON[0] && x <= LON[1] && y >= LAT[0] && y <= LAT[1];

function checkPolygons(fc: FeatureCollection) {
	const rings = fc.features.flatMap((f) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.flat() : [[]]));
	const closed = (r: Position[]) => r.length >= 4 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1];
	check(rings.every(closed), `every polygon ring is closed: ${rings.length} rings`);
	check(rings.flat().every(inBox), 'every vertex is in the study area, in lon/lat order');
	console.log(`  info ${rings.flat().length} vertices`);
}

const text = (fc: FeatureCollection, key: string) => fc.features.map((f) => String(f.properties?.[key]));

async function quaternaries() {
	console.log('Quaternary catchments');
	await checkLayer(quaternaryUrl(), ['OBJECTID', 'QUATERNARY', 'PRIMARY_', 'TERTIARY']);
	const fc = await checkLoad(quaternaryUrl(), loadQuaternaries);
	const have = new Set(text(fc, 'q'));
	check(have.size === fc.features.length, 'no quaternary twice');
	check(text(fc, 'q').every((q) => /^[A-Z]\d{2}[A-Z]$/.test(q)), 'every quaternary is a code like Z80D');
	checkPolygons(fc);

	// A node can name two quaternaries, split by a slash, or none at all.
	const { nodes, sample } = JSON.parse(readFileSync(new URL('../static/data/index.json', import.meta.url), 'utf8')) as { nodes: { id: string; quat: string }[]; sample?: boolean };
	if (sample) {
		console.log('  info node quaternaries not checked: static/data is the sample, whose codes are invented');
		return;
	}
	const missing = nodes.filter((n) => n.quat && !n.quat.split('/').every((q) => have.has(q.trim())));
	check(!missing.length, `every node's quaternary came back, of ${nodes.length} nodes${missing.length ? `. Missing: ${missing.map((n) => `${n.id} (${n.quat})`).join(', ')}` : ''}`);
}

async function basins() {
	console.log('Basins (WMA_2004)');
	await checkLayer(basinUrl(), ['OBJECTID', 'WMA_Name']);
	const fc = await checkLoad(basinUrl(), loadBasins);
	check(BASINS.every((b) => text(fc, 'b').includes(b)) && fc.features.length === BASINS.length, `the four basins came back by name: ${BASINS.join(', ')}`);
	checkPolygons(fc);
}

async function gauges() {
	console.log('Flow gauges');
	await checkLayer(gaugeUrl(), ['OBJECTID', 'Station', 'Name', 'Quat', 'Status']);
	const fc = await checkLoad(gaugeUrl(), loadGauges);
	const stations = text(fc, 'station');
	check(new Set(stations).size === stations.length, 'no station twice');
	check(stations.every((s) => /^[A-Z]\dH\d{3}$/.test(s)), 'every station is a flow gauge number like X0H000');
	check(REGIONS.every((r) => stations.some((s) => s.startsWith(r))), `every drainage region has gauges: ${REGIONS.join(', ')}`);
	check(fc.features.every((f) => f.geometry.type === 'Point' && inBox(f.geometry.coordinates)), 'every gauge is a point in the study area, in lon/lat order');
	console.log(`  info ${text(fc, 'closed').filter((c) => c === 'true').length} closed, ${text(fc, 'quat').filter((q) => !q).length} with no quaternary`);

	// `closed` is "not Active Weirs", so a new status would read as closed without anyone noticing.
	const raw = await json(variant(gaugeUrl(), { returnDistinctValues: 'true', returnGeometry: 'false', outFields: 'Status', orderByFields: 'Status', f: 'json' }));
	const statuses: string[] = raw.features.map((f: { attributes: { Status: string } }) => f.attributes.Status);
	check(statuses.length > 0 && statuses.every((s) => STATUSES.includes(s)), `the status is one of ${STATUSES.join(', ')}: found ${statuses.join(', ')}`);
}

/** The behaviour `getAll` leans on, shown on the real service with a query the limit cuts off. */
async function limits() {
	console.log('Limits and errors');
	const whole = variant(gaugeUrl(), { where: '1=1', outFields: 'OBJECTID', returnGeometry: 'false' }).href;
	const cut = await json(variant(whole, { resultRecordCount: '1' }));
	check(cut.properties?.exceededTransferLimit === true, 'a cut-off GeoJSON result sets properties.exceededTransferLimit');
	const expected = await count(whole);
	const paged = await getAll(whole);
	const ids = new Set(paged.features.map((f) => f.id));
	check(paged.features.length === expected && ids.size === expected, `paging fetches a layer past its limit once each: ${ids.size} of ${expected}`);
	check(await getAll(variant(gaugeUrl(), { where: 'NoSuchField = 1' }).href).then(() => false, () => true), 'a bad query is reported as an error');
}

for (const run of [quaternaries, basins, gauges, limits]) {
	try {
		await run();
	} catch (e) {
		check(false, `${run.name} stopped: ${(e as Error).message}`);
	}
}

console.log(violations.length ? `\n${violations.length} violation(s)` : '\nAll contracts hold');
process.exit(violations.length ? 1 : 0);
