import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildNotices, resolveView } from './resolve.ts';
import type { EwrNode } from './types.ts';

const node = (over: Partial<EwrNode>): EwrNode => ({
	id: 'Test:n1', label: 'N1', basin: 'Test', quat: 'Z10A', river: '', comment: '', lon: 19, lat: -33, approx: false,
	pes: '', rec: '', tec: '', tecInc: '', tecCum: '', iua: '', ewrClass: '', ru: '', ewrBasis: '', ewrNote: '', gazPct: null,
	sites: [], ecSource: {}, files: [], ecsAvailable: [], hasTab: false, hasRevised: false, ...over
});

const texts = (n: EwrNode) => buildNotices(n, resolveView(n, 'TEC'), 'TEC', {}, null, null).map((x) => x.text);

test('a node with no EWR says why, when the sources do', () => {
	const why = 'The Reserve report sets the EWR here at 100% of nMAR.';
	assert.ok(texts(node({ ewrNote: why })).includes(why));
	assert.deepEqual(texts(node({})), ['No EWR files were supplied for this node.']);
});

test('a node with flow series only still says what is missing', () => {
	const files = [{ name: 'X.mrv', kind: 'mrv' as const, ec: 'B', basis: '' }];
	assert.match(texts(node({ files }))[0], /flow series only/);
});

test('the panel says when a location is approximate, and which quaternary holds it', () => {
	assert.ok(texts(node({ approx: true })).some((t) => t.includes('Location approximate') && t.includes('Z10A')));
	assert.ok(!texts(node({})).some((t) => t.includes('Location approximate')));
});

test('a node with no coordinates says it is not on the map', () => {
	assert.ok(texts(node({ lon: null, lat: null, quat: '' })).some((t) => t.startsWith('Not on the map')));
});
