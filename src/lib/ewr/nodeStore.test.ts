import { describe, expect, it } from 'vitest';
import { NODE_STORE_LIMITS, nodeKey, nodeStoreKey, nodeStorePath, parseNodeStoreIndex, parseNodeTexts, parseWmaOverlay } from './nodeStore.ts';

const WMAS = ['breede-olifants', 'vaal-orange'];
const time = '2026-11-12T09:00:00+02:00';

/** A synthetic uploaded node, as the import panel writes it. */
const node = (key = 'syx1', extra: Record<string, unknown> = {}) => ({
	id: `vaal-orange:${key}`,
	label: key.toUpperCase(),
	basin: 'Sample Basin',
	river: 'Sample River',
	lon: 26.5,
	lat: -28.1,
	tec: 'C',
	files: [
		{ name: `${key}C.tab`, kind: 'tab', ec: 'C', basis: '' },
		{ name: `${key}.rul(NEWFORM)`, kind: 'revised', ec: '', basis: '' }
	],
	...extra
});
const overlay = (extra: Record<string, unknown> = {}) => ({ version: 1, wma: 'vaal-orange', updatedAt: time, nodes: [node()], deleted: ['Basin:old1'], ...extra });

describe('nodeStorePath and nodeStoreKey', () => {
	it('puts each file under nodes-data/, and its key under serve/', () => {
		expect(nodeStorePath.index).toBe('nodes-data/index.json');
		expect(nodeStorePath.wma('vaal-orange')).toBe('nodes-data/wma-vaal-orange.json');
		expect(nodeStorePath.files('vaal-orange', 'syx1')).toBe('nodes-data/files/vaal-orange/syx1.json');
		expect(nodeStoreKey(nodeStorePath.index)).toBe('serve/nodes-data/index.json');
	});
});

describe('nodeKey', () => {
	it('is the part after the WMA, when that is a safe key', () => {
		expect(nodeKey('vaal-orange:syx1', 'vaal-orange')).toBe('syx1');
		expect(nodeKey('vaal-orange:a_b-2', 'vaal-orange')).toBe('a_b-2');
	});

	it.each([
		['another WMA', 'breede-olifants:syx1'],
		['a built-in id', 'Basin:syx1'],
		['uppercase', 'vaal-orange:SYX1'],
		['a path', 'vaal-orange:../x'],
		['a space', 'vaal-orange:sy x1'],
		['nothing', 'vaal-orange:'],
		['too long', `vaal-orange:${'a'.repeat(41)}`]
	])('is null for %s', (_, id) => {
		expect(nodeKey(id, 'vaal-orange')).toBeNull();
	});
});

describe('parseNodeStoreIndex', () => {
	it('reads each WMA, and a store with none', () => {
		expect(parseNodeStoreIndex({ version: 1, wmas: { 'vaal-orange': { updatedAt: time, nodes: 3, deleted: 1 } } }, WMAS).wmas).toEqual({ 'vaal-orange': { updatedAt: time, nodes: 3, deleted: 1 } });
		expect(parseNodeStoreIndex({ version: 1, wmas: {} }, WMAS).wmas).toEqual({});
	});

	it.each([
		['not an object', [], 'nodes-data/index.json is not a JSON object.'],
		['another version', { version: 2, wmas: {} }, 'nodes-data/index.json is format version 2; this app reads 1.'],
		['no wmas', { version: 1 }, 'nodes-data/index.json has no wmas.'],
		['an unknown WMA', { version: 1, wmas: { atlantis: { updatedAt: time, nodes: 0, deleted: 0 } } }, 'nodes-data/index.json: atlantis is not a WMA.'],
		['a count that is not one', { version: 1, wmas: { 'vaal-orange': { updatedAt: time, nodes: -1, deleted: 0 } } }, 'nodes-data/index.json: vaal-orange needs updatedAt, nodes and deleted.'],
		['a date with no time', { version: 1, wmas: { 'vaal-orange': { updatedAt: '2026-11-12', nodes: 0, deleted: 0 } } }, 'nodes-data/index.json: vaal-orange needs updatedAt, nodes and deleted.']
	])('refuses %s', (_, json, message) => {
		expect(() => parseNodeStoreIndex(json, WMAS)).toThrow(message);
	});
});

describe('parseWmaOverlay', () => {
	it('reads a WMA, filling every field a node leaves out', () => {
		const o = parseWmaOverlay(overlay(), 'vaal-orange', WMAS);
		expect(o.deleted).toEqual(['Basin:old1']);
		expect(o.nodes).toEqual([
			{
				id: 'vaal-orange:syx1', label: 'SYX1', basin: 'Sample Basin', quat: '', river: 'Sample River', comment: '', lon: 26.5, lat: -28.1, approx: false,
				pes: '', rec: '', tec: 'C', tecInc: '', tecCum: '', iua: '', ewrClass: '', ru: '', ewrBasis: '', ewrNote: '', gazPct: null, sites: [], ecSource: {},
				files: [{ name: 'syx1C.tab', kind: 'tab', ec: 'C', basis: '' }, { name: 'syx1.rul(NEWFORM)', kind: 'revised', ec: '', basis: '' }],
				ecsAvailable: ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D'], hasTab: true, hasRevised: true
			}
		]);
	});

	it('works out hasTab, hasRevised and ecsAvailable from the files, as build_data.py does, whatever the upload says', () => {
		const of = (files: unknown[]) => parseWmaOverlay(overlay({ nodes: [node('syx1', { files, hasTab: true, hasRevised: true, ecsAvailable: ['A'] })] }), 'vaal-orange', WMAS).nodes[0];
		const pick = (n: ReturnType<typeof of>) => [n.hasTab, n.hasRevised, n.ecsAvailable];
		expect(pick(of([]))).toEqual([false, false, []]);
		expect(pick(of([{ name: 'a.tab', kind: 'tab', ec: '' }]))).toEqual([false, false, []]);
		expect(pick(of([{ name: 'aD.tab', kind: 'tab', ec: 'D' }, { name: 'aB_Con.txt', kind: 'con', ec: 'B' }, { name: 'aC.mrv', kind: 'mrv', ec: 'C' }]))).toEqual([true, false, ['B', 'D']]);
		expect(pick(of([{ name: 'aE.tab', kind: 'tab', ec: 'E' }, { name: 'a.rul(NEWFORM)', kind: 'revised', ec: '' }]))).toEqual([true, true, ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D', 'E']]);
	});

	it('keeps how a file\'s EC was decided, and drops a repeated deleted id', () => {
		const files = [{ name: 'syx1B.tab', kind: 'tab', ec: 'C', basis: '', ecNote: 'Identical to the C run, so treated as C' }];
		const o = parseWmaOverlay(overlay({ nodes: [node('syx1', { files })], deleted: ['Basin:a', 'Basin:a'] }), 'vaal-orange', WMAS);
		expect(o.nodes[0].files[0].ecNote).toBe('Identical to the C run, so treated as C');
		expect(o.deleted).toEqual(['Basin:a']);
	});

	it('reads a node with no location', () => {
		expect(parseWmaOverlay(overlay({ nodes: [node('syx1', { lon: null, lat: null })] }), 'vaal-orange', WMAS).nodes[0].lon).toBeNull();
	});

	it.each([
		['a WMA that is not one', overlay(), 'atlantis', 'atlantis is not a WMA.'],
		['another version', overlay({ version: 2 }), 'vaal-orange', 'nodes-data/wma-vaal-orange.json is format version 2; this app reads 1.'],
		['another WMA\'s file', overlay({ wma: 'breede-olifants' }), 'vaal-orange', 'nodes-data/wma-vaal-orange.json is for breede-olifants, not vaal-orange.'],
		['no time', overlay({ updatedAt: 'today' }), 'vaal-orange', 'has no updatedAt time.'],
		['a node of another WMA', overlay({ nodes: [{ ...node(), id: 'breede-olifants:syx1' }] }), 'vaal-orange', 'node 1: id must be vaal-orange:<key>'],
		['a node twice', overlay({ nodes: [node(), node()] }), 'vaal-orange', 'vaal-orange:syx1 is there twice.'],
		['a node with no label', overlay({ nodes: [node('syx1', { label: ' ' })] }), 'vaal-orange', 'label must be text.'],
		['half a location', overlay({ nodes: [node('syx1', { lat: null })] }), 'vaal-orange', 'lon and lat go together.'],
		['a latitude off the globe', overlay({ nodes: [node('syx1', { lat: -95 })] }), 'vaal-orange', 'lat must be a number from -90 to 90, or null.'],
		['a file of no known kind', overlay({ nodes: [node('syx1', { files: [{ name: 'a.exe', kind: 'exe', ec: '' }] })] }), 'vaal-orange', 'kind must be one of'],
		['a file name with a path', overlay({ nodes: [node('syx1', { files: [{ name: '../a.tab', kind: 'tab', ec: 'C' }] })] }), 'vaal-orange', "name must be a file name"],
		['a file twice', overlay({ nodes: [node('syx1', { files: [{ name: 'a.tab', kind: 'tab' }, { name: 'a.tab', kind: 'tab' }] })] }), 'vaal-orange', 'a.tab is there twice.'],
		['too many nodes', overlay({ nodes: Array.from({ length: NODE_STORE_LIMITS.nodesPerWma + 1 }, (_, i) => node(`n${i}`)) }), 'vaal-orange', `more than ${NODE_STORE_LIMITS.nodesPerWma} nodes`],
		['a deleted id that is not text', overlay({ deleted: [3] }), 'vaal-orange', 'deleted 1 is not a node id.']
	])('refuses %s', (_, json, wma, message) => {
		expect(() => parseWmaOverlay(json, wma, WMAS)).toThrow(message);
	});
});

describe('parseNodeTexts', () => {
	const n = parseWmaOverlay(overlay(), 'vaal-orange', WMAS).nodes[0];
	const texts = { 'syx1C.tab': 'SYNTHETIC tab', 'syx1.rul(NEWFORM)': 'SYNTHETIC rul' };

	it('reads one text for each of the node\'s files', () => {
		expect(parseNodeTexts(texts, n, 'vaal-orange')).toEqual(texts);
	});

	it.each([
		['a file the node does not have', { ...texts, 'other.tab': 'x' }, 'other.tab is not one of the node\'s files.'],
		['a file with no text', { 'syx1C.tab': 'x' }, 'syx1.rul(NEWFORM) has no text.'],
		['text that is not text', { ...texts, 'syx1C.tab': 3 }, 'syx1C.tab is not text.'],
		['a file too long', { ...texts, 'syx1C.tab': 'x'.repeat(NODE_STORE_LIMITS.fileChars + 1) }, `longer than ${NODE_STORE_LIMITS.fileChars} characters`]
	])('refuses %s', (_, json, message) => {
		expect(() => parseNodeTexts(json, n, 'vaal-orange')).toThrow(message);
	});

	it('refuses a node whose files are too long together', () => {
		const big = 'x'.repeat(NODE_STORE_LIMITS.fileChars);
		const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.tab`, kind: 'tab', ec: 'C' }));
		const many = parseWmaOverlay(overlay({ nodes: [node('syx1', { files })] }), 'vaal-orange', WMAS).nodes[0];
		expect(() => parseNodeTexts(Object.fromEntries(files.map((f) => [f.name, big])), many, 'vaal-orange')).toThrow('together are longer than');
	});

	it('refuses a built-in node', () => {
		expect(() => parseNodeTexts(texts, { ...n, id: 'Basin:syx1' }, 'vaal-orange')).toThrow('Basin:syx1 is not an uploaded node of vaal-orange.');
	});
});
