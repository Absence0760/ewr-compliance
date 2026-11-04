// Checks the live ArcGIS layers against what the app assumes of them, using the app's own
// queries. e2e stubs these services, so this is the only thing that ever calls the real ones.
// Run with `node tools/check-live-services.ts`: exits 1 on a violation. It keeps no copy of the
// data: DWS supplies it without distribution rights (NOTICE.md), so print only counts, and write nothing.
import { readFileSync } from 'node:fs';
import type { FeatureCollection, Position } from 'geojson';
import {
	basinUrl, gaugeUrl, getAll, loadBasins, loadGauges, loadQuaternaries, loadWma, loadWmas, outlineOf, quaternaryUrl, wmasUrl
} from '../src/lib/components/map/catchments.ts';
import { BASIN_WMA, WMAS, wmaBySlug, wmaOfBasin } from '../src/lib/components/map/wma.ts';

const BASINS = ['Berg', 'Breede', 'Gouritz', 'Olifants/Doorn'];
/** The WMA the study basins are in, which the checks of catchments and gauges run on. */
const STUDY = wmaBySlug('breede-olifants')!;
/** Drainage regions of the study area, by the first letter of a station number. Each must have a gauge. */
const REGIONS = ['E', 'G', 'H', 'J', 'K'];
const STATUSES = ['Active Weirs', 'Inactive Weirs'];
/** South Africa, generously. A point outside it means swapped axes or the wrong datum. */
const LON = [16, 33.5];
const LAT = [-35.5, -21.5];

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
	const q = new URLSearchParams({ returnCountOnly: 'true', f: 'json' });
	// The where and any box, which together are the query.
	for (const k of ['where', 'geometry', 'geometryType', 'inSR', 'spatialRel']) if (u.searchParams.has(k)) q.set(k, u.searchParams.get(k)!);
	const answer = await json(`${u.origin}${u.pathname}?${q}`);
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
	check(rings.flat().every(inBox), 'every vertex is in South Africa, in lon/lat order');
	console.log(`  info ${rings.flat().length} vertices`);
}

const text = (fc: FeatureCollection, key: string) => fc.features.map((f) => String(f.properties?.[key]));

/** The six WMAs of 2023 by name, each one's outline on its own, and nothing else but Lesotho and Eswatini. */
async function wmas() {
	console.log('Water Management Areas (WMA_2023)');
	await checkLayer(wmasUrl(), ['OBJECTID', 'WMA_NAME']);
	const fc = await checkLoad(wmasUrl(), loadWmas);
	const slugs = text(fc, 'w');
	check(WMAS.every((w) => slugs.includes(w.slug)), `the six WMAs came back by name: ${WMAS.map((w) => w.service).join(', ')}`);
	check(text(fc, 'name').filter((_, i) => !slugs[i]).sort().join() === 'Eswatini,Lesotho', 'the only other areas are Lesotho and Eswatini');
	checkPolygons(fc);
	for (const w of WMAS) {
		const one = await loadWma(w);
		check(one.features.length >= 1 && text(one, 'w').every((n) => n === w.service), `${w.service} loads on its own`);
	}
}

async function quaternaries() {
	console.log(`Quaternary catchments, ${STUDY.name}`);
	await checkLayer(quaternaryUrl(STUDY), ['OBJECTID', 'QUATERNARY', 'PRIMARY_', 'TERTIARY']);
	const outline = outlineOf(await loadWma(STUDY));
	await checkLoad(quaternaryUrl(STUDY), () => loadQuaternaries(STUDY, null));
	const boxed = await loadQuaternaries(STUDY, null);
	const fc = await loadQuaternaries(STUDY, outline);
	console.log(`  info ${fc.features.length} in the WMA's outline, of ${boxed.features.length} in its box`);
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
	// A node is drawn on its basin's WMA (BASIN_WMA), so its quaternary must be in that WMA.
	const study = (n: { basin: string }) => wmaOfBasin(n.basin)?.slug === STUDY.slug;
	check(Object.values(BASIN_WMA).every((w) => w === STUDY.slug), `every basin is mapped to ${STUDY.name}, the WMA checked here`);
	const typed = nodes as { id: string; quat: string; basin: string }[];
	const unmapped = typed.filter((n) => !study(n));
	check(!unmapped.length, `every node's basin is in BASIN_WMA${unmapped.length ? `. Not: ${[...new Set(unmapped.map((n) => n.basin))].join(', ')}` : ''}`);
	// The app draws a node's quaternary on the node's WMA wherever it lies, so it must be in the box.
	// One mostly over the line is worth knowing, not a failure.
	const inBoxQ = new Set(text(boxed, 'q'));
	const quatsOf = (n: { quat: string }) => n.quat.split('/').map((q) => q.trim()).filter(Boolean);
	const missing = typed.filter((n) => !quatsOf(n).every((q) => inBoxQ.has(q)));
	check(!missing.length, `every node's quaternary came back in the box of ${STUDY.name}, of ${nodes.length} nodes${missing.length ? `. Missing: ${missing.map((n) => `${n.id} (${n.quat})`).join(', ')}` : ''}`);
	const over = typed.filter((n) => !quatsOf(n).every((q) => have.has(q)));
	console.log(`  info ${over.length} node(s) whose quaternary lies mostly outside the WMA's outline, drawn with the node anyway${over.length ? `: ${over.map((n) => n.id).join(', ')}` : ''}`);
}

async function basins() {
	console.log('Basins (WMA_2004)');
	await checkLayer(basinUrl(), ['OBJECTID', 'WMA_Name']);
	const fc = await checkLoad(basinUrl(), loadBasins);
	check(BASINS.every((b) => text(fc, 'b').includes(b)) && fc.features.length === BASINS.length, `the four basins came back by name: ${BASINS.join(', ')}`);
	checkPolygons(fc);
}

async function gauges() {
	console.log(`Flow gauges, ${STUDY.name}`);
	await checkLayer(gaugeUrl(STUDY), ['OBJECTID', 'Station', 'Name', 'Quat', 'Status']);
	const fc = await checkLoad(gaugeUrl(STUDY), () => loadGauges(STUDY, null));
	const stations = text(fc, 'station');
	check(new Set(stations).size === stations.length, 'no station twice');
	check(stations.every((s) => /^[A-Z]\dH\d{3}$/.test(s)), 'every station is a flow gauge number like X0H000');
	check(REGIONS.every((r) => stations.some((s) => s.startsWith(r))), `every drainage region has gauges: ${REGIONS.join(', ')}`);
	check(fc.features.every((f) => f.geometry.type === 'Point' && inBox(f.geometry.coordinates)), 'every gauge is a point in South Africa, in lon/lat order');
	console.log(`  info ${text(fc, 'closed').filter((c) => c === 'true').length} closed, ${text(fc, 'quat').filter((q) => !q).length} with no quaternary`);

	// `closed` is "not Active Weirs", so a new status would read as closed without anyone noticing.
	const raw = await json(variant(gaugeUrl(STUDY), { returnDistinctValues: 'true', returnGeometry: 'false', outFields: 'Status', orderByFields: 'Status', f: 'json' }));
	const statuses: string[] = raw.features.map((f: { attributes: { Status: string } }) => f.attributes.Status);
	check(statuses.length > 0 && statuses.every((s) => STATUSES.includes(s)), `the status is one of ${STATUSES.join(', ')}: found ${statuses.join(', ')}`);
}

/** The behaviour `getAll` leans on, shown on the real service with a query the limit cuts off. */
async function limits() {
	console.log('Limits and errors');
	const boxed = variant(gaugeUrl(STUDY), { where: '1=1', outFields: 'OBJECTID', returnGeometry: 'false' }).href;
	// The whole layer, past the page limit: no box.
	const wholeUrl = new URL(boxed);
	for (const k of ['geometry', 'geometryType', 'inSR', 'spatialRel']) wholeUrl.searchParams.delete(k);
	const whole = wholeUrl.href;
	const cut = await json(variant(whole, { resultRecordCount: '1' }));
	check(cut.properties?.exceededTransferLimit === true, 'a cut-off GeoJSON result sets properties.exceededTransferLimit');
	const expected = await count(whole);
	const paged = await getAll(whole);
	const ids = new Set(paged.features.map((f) => f.id));
	check(paged.features.length === expected && ids.size === expected, `paging fetches a layer past its limit once each: ${ids.size} of ${expected}`);
	check(await getAll(variant(gaugeUrl(STUDY), { where: 'NoSuchField = 1' }).href).then(() => false, () => true), 'a bad query is reported as an error');
}

for (const run of [wmas, quaternaries, basins, gauges, limits]) {
	try {
		await run();
	} catch (e) {
		check(false, `${run.name} stopped: ${(e as Error).message}`);
	}
}

console.log(violations.length ? `\n${violations.length} violation(s)` : '\nAll contracts hold');
process.exit(violations.length ? 1 : 0);
