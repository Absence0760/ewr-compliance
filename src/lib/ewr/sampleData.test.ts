// The synthetic dataset in e2e/fixtures/sample-data is what public CI runs on, so it has to keep
// covering each kind of node the UI treats differently, and stay obviously invented.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseGaugeFlows, parseMon, parseTab } from './parsers.ts';
import { buildNotices, resolveView } from './resolve.ts';
import type { EwrNode, GaugeData, IndexData, NodeInfoData } from './types.ts';
import { wmaOfBasin } from '#lib/components/map/wma.ts';

const DIR = new URL('../../../e2e/fixtures/sample-data/', import.meta.url);
const load = (f: string) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const index = load('index.json') as IndexData & { sample: boolean };
const get = (id: string) => {
	const n = index.nodes.find((x) => x.id === id);
	assert.ok(n, id);
	return n;
};
const notices = (n: EwrNode) => buildNotices(n, resolveView(n, 'TEC'), 'TEC', {}, null, null).map((x) => x.text);

test('it says it is the sample, so nothing mistakes it for real data', () => {
	assert.equal(index.sample, true);
});

test('it has the same files as a real build, and no more', () => {
	const basins = ['berg', 'breede', 'gouritz', 'olifantsdoring'];
	const want = ['index.json', 'gauges.json', 'node-info.json', 'flows-X0H997.json', 'flows-X0H998.json', 'flows-X0H999.json', ...basins.flatMap((b) => [`ewr-${b}.json`, `series-${b}.json`])];
	assert.deepEqual(readdirSync(DIR).sort(), want.sort());
});

test("every node and site is in a WMA, or it would be on no WMA's map", () => {
	for (const x of [...index.nodes, ...index.sites]) assert.ok(wmaOfBasin(x.basin), `${x.basin}: ${x.label}`);
});

test('every basin the UI lists has a node on the map', () => {
	const placed = new Set(index.nodes.filter((n) => n.lon !== null).map((n) => n.basin));
	assert.deepEqual([...placed].sort(), ['Berg', 'Breede', 'Gouritz', 'Olifants-Doring']);
});

test('every file a node names is in its store, and every stored file is named', () => {
	const slug = (b: string) => b.toLowerCase().replace('-', '');
	for (const basin of new Set(index.nodes.map((n) => n.basin))) {
		const files = index.nodes.filter((n) => n.basin === basin).flatMap((n) => n.files);
		const stored = (f: { kind: string }) => (f.kind === 'mrv' || f.kind === 'hydro' ? 'series' : 'ewr');
		for (const group of ['ewr', 'series']) {
			const names = files.filter((f) => stored(f) === group).map((f) => f.name).sort();
			assert.deepEqual(Object.keys(load(`${group}-${slug(basin)}.json`)).sort(), names, `${group} ${basin}`);
		}
	}
});

test('it covers a .tab node, with an EWR site at the same point', () => {
	const n = get('Gouritz:syt1');
	assert.equal(n.hasTab, true);
	const site = index.sites.find((s) => s.node === n.id);
	assert.ok(site);
	assert.deepEqual([site.lon, site.lat, n.sites[0].label], [n.lon, n.lat, site.label]);
});

test('it covers a Revised .rul node and a flow-only node', () => {
	assert.deepEqual([get('Gouritz:syr1').hasRevised, get('Gouritz:syr1').hasTab], [true, false]);
	assert.match(notices(get('Gouritz:syf1'))[0], /flow series only/);
});

test('it covers an Olifants-Doring node with both flow bases, and a gazette that matches its constructed file', () => {
	const n = get('Olifants-Doring:z10b');
	assert.deepEqual(new Set(n.files.map((f) => f.basis)), new Set(['cum', 'inc']));
	const store = load('ewr-olifantsdoring.json') as Record<string, string>;
	assert.equal(parseTab(store['Cum/Z10B_C_Cum_Con.txt']).totalPct, n.gazPct);
	assert.notEqual(parseTab(store['Cum/Z10B_C_cum.tab']).totalPct, n.gazPct);
});

test('it covers an approximate node and a node with no coordinates', () => {
	assert.ok(notices(get('Breede:syq1')).some((t) => t.startsWith('Location approximate')));
	assert.ok(notices(get('Berg:syx1')).some((t) => t.startsWith('Not on the map')));
});

test('it covers a site with no node', () => {
	assert.ok(index.sites.some((s) => s.node === null));
});

test('every gauge link joins a node to a record it can read, with a factor to apply', () => {
	const { links, records, flows } = load('gauges.json') as GaugeData;
	assert.ok(links.some((l) => l.factor !== 1));
	for (const l of links) {
		get(l.node);
		assert.ok(records[l.station] || flows.includes(l.station), l.station);
	}
	for (const [station, text] of Object.entries(records)) assert.equal(parseMon(text).station, station);
	for (const station of flows) assert.ok(parseGaugeFlows(load(`flows-${station}.json`)).daily.length, station);
});

test('node info is keyed by nodes that exist, and covers a node with all of it and one with part', () => {
	const info = load('node-info.json') as NodeInfoData;
	for (const id of Object.keys(info)) get(id);
	const counts = Object.values(info).map((i) => Object.keys(i).length);
	assert.ok(counts.includes(5));
	assert.ok(counts.some((c) => c > 0 && c < 5));
});

test('no node info looks like a real site or station', () => {
	for (const [id, i] of Object.entries(load('node-info.json') as NodeInfoData)) {
		for (const v of [i.remp, i.ewrSite].filter(Boolean)) assert.match(v!, /^SYN-/, id);
		if (i.wqStation) assert.match(i.wqStation, /^Z\d\d 0+\d$/, id);
	}
});

test('no node code, quaternary or file name looks like a real one', () => {
	for (const n of index.nodes) {
		assert.match(n.id.split(':')[1], /^(sy[a-z]\d|z\d\d[a-z])$/, n.id);
		assert.match(n.quat, /^(Z\d\d[A-Z])?$/, n.id);
		for (const f of n.files) assert.match(f.name, /(^|\/)(SY|sy|Z1)/, f.name);
	}
});
