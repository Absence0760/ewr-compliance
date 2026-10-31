import type { FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { EwrNode, EwrSite, NodeFile, NodeView } from '#lib/ewr/types.ts';
import {
	boundsOf, fileInUse, fileOption, findEntry, gaugeLabels, labelPoints, nodeFeatures, nodeLabel, searchEntries, siteFeatures
} from './mapData.ts';

const node = (over: Partial<EwrNode>): EwrNode => ({
	id: 'Berg:a', label: 'a', basin: 'Berg', quat: 'Z10A', river: '', comment: '', lon: 19, lat: -33, approx: false,
	pes: '', rec: '', tec: '', tecInc: '', tecCum: '', iua: '', ewrClass: '', ru: '', ewrBasis: '', gazPct: null,
	sites: [], ecSource: {}, files: [], ecsAvailable: ['C'], hasTab: true, hasRevised: false, ...over
});
const site = (over: Partial<EwrSite>): EwrSite => ({
	label: 'S1', basin: 'Berg', lon: 19, lat: -33, river: '', node: null, source: '', ...over
});
const file = (name: string, kind: NodeFile['kind'], ec = ''): NodeFile => ({ name, kind, ec, basis: '' });
const keys = (labels: { key: string }[]) => labels.map((l) => l.key);

describe('gaugeLabels', () => {
	const gauges: FeatureCollection = {
		type: 'FeatureCollection',
		features: [
			{ type: 'Feature', geometry: { type: 'Point', coordinates: [21, -34] }, properties: { station: 'X0H001', closed: false } },
			{ type: 'Feature', geometry: { type: 'Point', coordinates: [22, -34] }, properties: { station: 'X0H002', closed: true } }
		]
	};
	const texts = (open: boolean, closed: boolean) => gaugeLabels(gauges, open, closed).map((l) => l.text);

	it('labels each layer that is on, by station number', () => {
		expect(texts(true, false)).toEqual(['X0H001']);
		expect(texts(false, true)).toEqual(['X0H002']);
		expect(texts(true, true)).toEqual(['X0H001', 'X0H002']);
		expect(texts(false, false)).toEqual([]);
	});

	it('has nothing to label before the gauges load', () => {
		expect(gaugeLabels(null, true, true)).toEqual([]);
	});
});

describe('nodeLabel', () => {
	it('is the bare label with no sites', () => {
		expect(nodeLabel(node({ label: 'syt1' }))).toBe('syt1');
	});
	it('shows both labels when co-located', () => {
		const n = node({ label: 'syt1', sites: [{ label: 'SYN-SITE1', how: 'x' }] });
		expect(nodeLabel(n)).toBe('syt1 / SYN-SITE1');
	});
	it('lists every co-located site', () => {
		const n = node({ label: 'b', sites: [{ label: 'S1', how: 'x' }, { label: 'S2', how: 'x' }] });
		expect(nodeLabel(n)).toBe('b / S1, S2');
	});
});

describe('nodeFeatures', () => {
	it('drops nodes with no location and marks usable and approximate', () => {
		const out = nodeFeatures([
			node({ id: 'yes', approx: true }),
			node({ id: 'nofile', ecsAvailable: [] }),
			node({ id: 'nowhere', lon: null, lat: null })
		]);
		expect(out.features.map((f) => f.properties)).toEqual([
			{ id: 'yes', label: 'a', usable: true, approx: true },
			{ id: 'nofile', label: 'a', usable: false, approx: false }
		]);
		expect(out.features[0].geometry.coordinates).toEqual([19, -33]);
	});
});

describe('siteFeatures', () => {
	it('keeps the index into sites and blanks an unknown or missing node', () => {
		const out = siteFeatures(
			[site({ node: 'Berg:a' }), site({ node: null }), site({ node: 'Gone' })],
			[node({ id: 'Berg:a' })]
		);
		expect(out.features.map((f) => [f.properties.i, f.properties.node])).toEqual([[0, 'Berg:a'], [1, ''], [2, '']]);
	});
});

describe('labelPoints', () => {
	const onIt = { label: 'S1', how: 'x' };

	it('gives a co-located site no label of its own', () => {
		const out = labelPoints([node({ sites: [onIt] })], [site({ node: 'Berg:a' })], false);
		expect(out.map((l) => l.text)).toEqual(['a / S1']);
	});
	it('labels a site with different coordinates from its node', () => {
		const out = labelPoints([node({ sites: [onIt] })], [site({ node: 'Berg:a', lon: 19.001 })], false);
		expect(keys(out)).toEqual(['node:Berg:a', 'site:0']);
	});
	it('labels a site with no node', () => {
		expect(labelPoints([], [site({})], false).map((l) => l.text)).toEqual(['S1']);
	});
	it('labels a site the node does not list', () => {
		expect(keys(labelPoints([node({})], [site({ node: 'Berg:a' })], false))).toEqual(['node:Berg:a', 'site:0']);
	});
	it('hides no-EC-file nodes until asked', () => {
		const n = node({ ecsAvailable: [] });
		expect(labelPoints([n], [], false)).toEqual([]);
		expect(keys(labelPoints([n], [], true))).toEqual(['node:Berg:a']);
	});
	it('keeps a site named when its co-located node is hidden', () => {
		const n = node({ ecsAvailable: [], sites: [onIt] });
		const s = site({ node: 'Berg:a' });
		expect(labelPoints([n], [s], false).map((l) => l.text)).toEqual(['S1']);
		expect(labelPoints([n], [s], true).map((l) => l.text)).toEqual(['a / S1']);
	});
	it('skips a node with no location but keeps its site', () => {
		const out = labelPoints([node({ lon: null, lat: null, sites: [onIt] })], [site({ node: 'Berg:a' })], true);
		expect(keys(out)).toEqual(['site:0']);
	});
});

describe('search', () => {
	it('finds a node, and a linked site as its node, once', () => {
		const n = node({ sites: [{ label: 'S1', how: 'x' }] });
		const entries = searchEntries([n], [site({ node: 'Berg:a' })]);
		expect(entries.map((e) => e.value)).toEqual(['a', 'S1']);
		expect(findEntry(entries, ' s1 ')?.target).toEqual({ kind: 'node', id: 'Berg:a' });
	});
	it('finds a site with no node as a site', () => {
		const entries = searchEntries([], [site({})]);
		expect(findEntry(entries, 'S1')?.target).toEqual({ kind: 'site', index: 0 });
	});
	it('finds a site name known only from a node', () => {
		const entries = searchEntries([node({ sites: [{ label: 'EWR 3', how: 'x' }] })], []);
		expect(findEntry(entries, 'EWR 3')?.target).toEqual({ kind: 'node', id: 'Berg:a' });
	});
	it('tells repeated labels apart by basin and keeps each reachable', () => {
		const entries = searchEntries(
			[node({ id: 'Berg:x', label: 'x' }), node({ id: 'Breede:x', label: 'x', basin: 'Breede' })],
			[]
		);
		expect(entries.map((e) => e.value)).toEqual(['x (Berg)', 'x (Breede)']);
		expect(findEntry(entries, 'x (Breede)')?.target).toEqual({ kind: 'node', id: 'Breede:x' });
		expect(findEntry(entries, 'x')?.target).toEqual({ kind: 'node', id: 'Berg:x' });
	});
	it('tells a site name on two nodes of one basin apart by node', () => {
		const shared = [{ label: 'EWR 5', how: 'x' }];
		const entries = searchEntries(
			[node({ id: 'O:a', label: 'a', sites: shared }), node({ id: 'O:b', label: 'b', sites: shared })],
			[]
		);
		expect(entries.map((e) => e.value)).toEqual(['a', 'b', 'EWR 5 (Berg, a)', 'EWR 5 (Berg, b)']);
		expect(findEntry(entries, 'EWR 5 (Berg, b)')?.target).toEqual({ kind: 'node', id: 'O:b' });
	});
	it('never lists one value twice', () => {
		const entries = searchEntries([], [site({}), site({})]);
		expect(entries.map((e) => e.value)).toEqual(['S1 (Berg)']);
	});
	it('matches nothing for blank or partial text', () => {
		const entries = searchEntries([node({ label: 'abc' })], []);
		expect(findEntry(entries, '  ')).toBeNull();
		expect(findEntry(entries, 'ab')).toBeNull();
	});
	it('orders numbers naturally', () => {
		const entries = searchEntries([node({ id: '1', label: 'n10' }), node({ id: '2', label: 'n2' })], []);
		expect(entries.map((e) => e.value)).toEqual(['n2', 'n10']);
	});
});

describe('boundsOf', () => {
	it('handles polygons and multipolygons together', () => {
		const polygon = [[[18, -34], [19, -33]]];
		const multi = [[[[20, -35], [21, -32]]]];
		expect(boundsOf([polygon, multi])).toEqual([[18, -35], [21, -32]]);
	});
});

describe('fileInUse', () => {
	const files = [file('a.tab', 'tab', 'C'), file('a_rev.rul', 'revised')];
	const view = (over: Partial<NodeView>) => ({ method: 'tab', source: null, ...over }) as NodeView;

	it('is the revised file under the revised method', () => {
		expect(fileInUse(view({ method: 'revised', source: files[0] }), files)).toBe('a_rev.rul');
	});
	it('is the source under the tab method', () => {
		expect(fileInUse(view({ source: files[0] }), files)).toBe('a.tab');
	});
	it('is undefined with no source', () => {
		expect(fileInUse(view({}), files)).toBeUndefined();
	});
});

describe('fileOption', () => {
	it('names the file, its EC and its kind', () => {
		expect(fileOption(file('a.tab', 'tab', 'C'))).toBe('a.tab (EC C) - .tab');
		expect(fileOption(file('a.mrv', 'mrv'))).toBe('a.mrv - .mrv');
	});
});
