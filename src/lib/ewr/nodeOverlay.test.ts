import { describe, expect, it } from 'vitest';
import { mergeOverlays, newNode, newNodeId, readNodeTexts } from './nodeOverlay.ts';
import { parseWmaOverlay, type WmaOverlay } from './nodeStore.ts';
import { parseTab } from './parsers.ts';
import type { EwrNode } from './types.ts';

// Every node, code and run here is synthetic.
const WMAS = ['breede-olifants', 'vaal-orange'];
const time = '2026-11-12T09:00:00+02:00';
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/** A tiny Desktop .tab: each month's Total is `scale` + its index / 10. */
function tab(ec: string, scale: number): string {
	const row = (m: string, i: number) => {
		const t = (scale + i / 10).toFixed(3);
		return `         ${m}  ${t}  0.1  0.1  ${t}  ${(Number(t) / 2).toFixed(3)}  0.000  ${t}`;
	};
	return ['        Synthetic Desktop output, invented for the tests', `        Ecological Category = ${ec}`, '', '        Month  Natural  SD  CV  Maint.  Drought  High  Total', ...MONTHS.map(row), ''].join('\n');
}

/** A built-in node, as data/index.json has one. */
const builtIn = (id: string, basin: string): EwrNode => ({
	id, label: id.split(':')[1], basin, quat: '', river: '', comment: '', lon: 19, lat: -33, approx: false, pes: '', rec: '', tec: 'C',
	tecInc: '', tecCum: '', iua: '', ewrClass: '', ru: '', ewrBasis: '', gazPct: null, sites: [], ecSource: {}, files: [],
	ecsAvailable: [], hasTab: false, hasRevised: false
});

/** An overlay as the app reads it, through the format's own check. */
const overlay = (wma: string, nodes: Record<string, unknown>[], deleted: string[] = []): WmaOverlay =>
	parseWmaOverlay({ version: 1, wma, updatedAt: time, nodes, deleted }, wma, WMAS);
const up = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id.split(':')[1].toUpperCase(), basin: 'Sample Basin', lon: 26, lat: -28, files: [], ...extra });

const BASIN_WMA: Record<string, string> = { Berg: 'breede-olifants', Gouritz: 'breede-olifants', Vaal: 'vaal-orange' };
const wmaOf = (n: EwrNode) => BASIN_WMA[n.basin];
const BUILT_IN = [builtIn('Berg:syb1', 'Berg'), builtIn('Gouritz:syg1', 'Gouritz'), builtIn('Vaal:syv1', 'Vaal')];

describe('mergeOverlays', () => {
	it('is the built-in nodes unchanged with no overlay', () => {
		const m = mergeOverlays(BUILT_IN, [], wmaOf);
		expect(m.nodes).toEqual(BUILT_IN);
		expect(m.hidden).toEqual([]);
		expect(m.uploaded.size).toBe(0);
	});

	it('adds uploaded nodes after the built-in ones, each in its overlay\'s WMA whatever its basin', () => {
		const m = mergeOverlays(BUILT_IN, [overlay('vaal-orange', [up('vaal-orange:syx1', { basin: 'Berg' })])], wmaOf);
		expect(m.nodes.map((n) => n.id)).toEqual(['Berg:syb1', 'Gouritz:syg1', 'Vaal:syv1', 'vaal-orange:syx1']);
		expect(m.uploaded.get('vaal-orange:syx1')).toBe('vaal-orange');
	});

	it('puts an uploaded node with a built-in node\'s id in its place', () => {
		const same = builtIn('vaal-orange:syx2', 'Vaal');
		const m = mergeOverlays([...BUILT_IN, same], [overlay('vaal-orange', [up('vaal-orange:syx2', { label: 'Replaced' })])], wmaOf);
		expect(m.nodes.map((n) => n.id)).toEqual(['Berg:syb1', 'Gouritz:syg1', 'Vaal:syv1', 'vaal-orange:syx2']);
		expect(m.nodes[3].label).toBe('Replaced');
		expect(m.uploaded.get('vaal-orange:syx2')).toBe('vaal-orange');
	});

	it('hides a built-in node its own WMA deleted, and lists it to restore', () => {
		const m = mergeOverlays(BUILT_IN, [overlay('breede-olifants', [], ['Gouritz:syg1', 'Gone:nothere'])], wmaOf);
		expect(m.nodes.map((n) => n.id)).toEqual(['Berg:syb1', 'Vaal:syv1']);
		expect(m.hidden).toEqual([{ wma: 'breede-olifants', node: BUILT_IN[1] }]);
	});

	it('never hides a node for another WMA\'s deleted list', () => {
		const m = mergeOverlays(BUILT_IN, [overlay('vaal-orange', [], ['Gouritz:syg1'])], wmaOf);
		expect(m.nodes).toHaveLength(3);
		expect(m.hidden).toEqual([]);
	});

	it('hides nothing of a basin no WMA claims', () => {
		const lost = builtIn('Nowhere:syn9', 'Nowhere');
		const m = mergeOverlays([lost], [overlay('vaal-orange', [], ['Nowhere:syn9'])], wmaOf);
		expect(m.nodes).toEqual([lost]);
	});
});

describe('readNodeTexts', () => {
	const node = overlay('vaal-orange', [
		up('vaal-orange:syx1', { files: [{ name: 'syx1C.tab', kind: 'tab', ec: 'C' }, { name: 'syx1D.tab', kind: 'tab', ec: 'D' }] })
	]).nodes[0];

	it('reads every file the node lists', () => {
		expect(readNodeTexts({ 'syx1C.tab': 'c', 'syx1D.tab': 'd' }, node, 'vaal-orange')).toEqual({ texts: { 'syx1C.tab': 'c', 'syx1D.tab': 'd' }, missing: [] });
	});

	it('names a listed file with no text as missing, and leaves out a text the node no longer lists', () => {
		expect(readNodeTexts({ 'syx1C.tab': 'c', 'syx1B.tab': 'old' }, node, 'vaal-orange')).toEqual({ texts: { 'syx1C.tab': 'c' }, missing: ['syx1D.tab'] });
	});

	it('refuses what is not a files object, and a text that is not text', () => {
		expect(() => readNodeTexts([], node, 'vaal-orange')).toThrow(/not a JSON object/);
		expect(() => readNodeTexts({ 'syx1C.tab': 3 }, node, 'vaal-orange')).toThrow(/syx1C.tab is not text/);
	});

	it('refuses a node that is not one of the WMA\'s uploads', () => {
		expect(() => readNodeTexts({}, builtIn('Berg:syb1', 'Berg'), 'vaal-orange')).toThrow(/not an uploaded node/);
	});
});

describe('newNode', () => {
	const base = { wma: 'vaal-orange', basin: 'Sample Basin', code: 'SYX-9', label: '', river: 'Test River', quat: 'Z99A', pes: 'C', rec: '', tec: 'B', lon: 26.2, lat: -28.4, files: [] };

	it('makes a node with no files as a location, as the import would', () => {
		const { node, texts, refused } = newNode(base);
		expect(node).toMatchObject({ id: 'vaal-orange:syx-9', label: 'SYX-9', basin: 'Sample Basin', river: 'Test River', quat: 'Z99A', pes: 'C', rec: '', tec: 'B', lon: 26.2, lat: -28.4 });
		expect(node.ecSource).toEqual({ pes: 'Node KML', tec: 'Node KML' });
		expect(node.files).toEqual([]);
		expect(node.ecsAvailable).toEqual([]);
		expect(texts).toEqual({});
		expect(refused).toEqual([]);
	});

	it('takes a label when given one', () => {
		expect(newNode({ ...base, label: ' Test weir ' }).node.label).toBe('Test weir');
	});

	it('joins a file named for the code by its name, attaches any other Desktop output, and refuses the rest', () => {
		const { node, texts, refused } = newNode({
			...base,
			files: [
				{ name: 'SYX-9C.tab', text: tab('C', 1) },
				{ name: 'other.tab', text: tab('D', 2) },
				{ name: 'notes.doc', text: 'not a run' }
			]
		});
		expect(node.files.map((f) => [f.name, f.ec, f.ecNote ?? ''])).toEqual([
			['SYX-9C.tab', 'C', ''],
			['other.tab', 'D', 'Attached by an admin.']
		]);
		expect(node.ecsAvailable).toEqual(['C', 'D']);
		expect(node.hasTab).toBe(true);
		expect(Object.keys(texts)).toEqual(['SYX-9C.tab', 'other.tab']);
		expect(parseTab(texts['other.tab']).total[0]).toBeCloseTo(2);
		expect(refused).toEqual([{ file: 'notes.doc', detail: 'File name does not match a node code in the KML.' }]);
	});

	it('passes the format\'s check, as the API will', () => {
		const { node } = newNode({ ...base, files: [{ name: 'SYX-9C.tab', text: tab('C', 1) }] });
		expect(() => parseWmaOverlay({ version: 1, wma: 'vaal-orange', updatedAt: time, nodes: [node], deleted: [] }, 'vaal-orange', WMAS)).not.toThrow();
	});

	it('refuses a code that can\'t be a key', () => {
		expect(() => newNode({ ...base, code: '  ' })).toThrow(/can't be a node code/);
		expect(() => newNode({ ...base, code: 'x'.repeat(41) })).toThrow(/can't be a node code/);
	});
});

describe('newNodeId', () => {
	it('is the id the code is saved under, or null', () => {
		expect(newNodeId('vaal-orange', ' SYX 9 ')).toBe('vaal-orange:syx-9');
		expect(newNodeId('vaal-orange', '')).toBeNull();
	});
});
