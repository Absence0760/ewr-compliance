import { describe, expect, it } from 'vitest';
import type { Placemark } from './kml.ts';
import { parseNodeTexts, parseWmaOverlay } from './nodeStore.ts';
import { parseTab } from './parsers.ts';
import { attachable, attachFile, classify, codeKey, detachFile, fileEc, matchUpload, normEc, overrideEc, tabValues, type UploadResult } from './uploadMatch.ts';

// Every node, file and value here is synthetic: invented codes (syx1, syy2), rivers and runs.
const WMA = 'vaal-orange';
const WMAS = ['breede-olifants', 'vaal-orange'];
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/** A tiny Desktop .tab in the layout parseTab reads: each month's Total is `scale` + its index / 10. */
function tab(ec: string | null, scale: number, eol = '\n'): string {
	const row = (m: string, i: number) => {
		const t = (scale + i / 10).toFixed(3);
		return `         ${m}  ${t}  0.1  0.1  ${t}  ${(Number(t) / 2).toFixed(3)}  0.000  ${t}`;
	};
	return [
		'        Synthetic Desktop output, invented for the tests',
		'        MAR               =  100.000',
		...(ec === null ? [] : [`        Ecological Category = ${ec}`]),
		'',
		'        Month  Natural  SD  CV  Maint.  Drought  High  Total',
		...MONTHS.map(row),
		''
	].join(eol);
}

const pm = (code: string, data: Record<string, string> = {}, at: [number, number] = [26.5, -28.1]): Placemark => ({
	name: '',
	lon: at[0],
	lat: at[1],
	folder: null,
	data: { NODE: code, ...data }
});

const match = (placemarks: Placemark[], files: [string, string][]) =>
	matchUpload({ wma: WMA, basin: 'Sample Basin', placemarks, files: files.map(([name, text]) => ({ name, text })) });

const node = (r: UploadResult, key: string) => {
	const n = r.nodes.find((x) => x.id === `${WMA}:${key}`);
	if (!n) throw new Error(`no node ${key}`);
	return n;
};
const file = (r: UploadResult, key: string, name: string) => {
	const f = node(r, key).files.find((x) => x.name === name);
	if (!f) throw new Error(`no file ${name}`);
	return f;
};

/** Every result must pass the store's own checks: the overlay, and each node's texts. */
function roundTrip(r: UploadResult) {
	const overlay = parseWmaOverlay({ version: 1, wma: WMA, updatedAt: '2026-11-12T09:00:00+02:00', nodes: r.nodes, deleted: [] }, WMA, WMAS);
	expect(overlay.nodes).toEqual(r.nodes);
	for (const n of r.nodes) expect(parseNodeTexts(r.texts[n.id] ?? {}, n, WMA)).toEqual(r.texts[n.id] ?? {});
}

describe('the ports of build_data.py', () => {
	it('normEc reads two letters as a split category, and refuses what is off the ladder', () => {
		expect(['c', ' C/D ', 'cd', 'C D', 'AB', 'F', 'C/E', '', null].map(normEc)).toEqual(['C', 'C/D', 'C/D', 'C/D', 'A/B', '', '', '', '']);
	});

	it('fileEc reads the header in each of its three forms', () => {
		expect(fileEc('Ecological Category = bc')).toBe('');
		expect(fileEc('  Ecological Category = B/C\n')).toBe('B/C');
		expect(fileEc('Ecological Category   D\n')).toBe('D');
		expect(fileEc('Reserve Requirement for C Generic run')).toBe('C');
		expect(fileEc('No header here')).toBe('');
	});

	it('classify knows each Desktop output by its name', () => {
		expect(['syx1C.tab', 'syx1.RUL', 'syx1.rul(NEWFORM)', 'syx1C.mrv', 'syx1C_Con.txt', 'syx1.nat', 'syx1.PD', 'syx1.inc', 'syx1.cur', 'syx1.txt', 'syx1', '.tab'].map(classify)).toEqual([
			'tab',
			'rul',
			'revised',
			'mrv',
			'con',
			'hydro',
			'hydro',
			'hydro',
			'hydro',
			'',
			'',
			''
		]);
	});

	it('tabValues takes the text after each month that starts a line', () => {
		expect(tabValues('Oct 1 2\n  Nov 3 4\nNot Dec 5\nDec 6')).toEqual(['1 2', '3 4', '6']);
	});

	it('codeKey makes a code a safe key, or refuses it', () => {
		expect(codeKey('Syx1')).toBe('syx1');
		expect(codeKey('Syx1 (Sample)')).toBe('syx1-sample');
		expect(codeKey('***')).toBeNull();
		expect(codeKey('s'.repeat(41))).toBeNull();
	});
});

describe('matchUpload: placemarks to nodes', () => {
	it('makes a node of each placemark, with what the KML says of it', () => {
		const r = match(
			[
				pm('Syx1', { RIVER: ' Sample  River ', COMMENT: 'At the sample weir', QUAT: 'X00A', PES: 'c', reason: 'gauge' }),
				{ ...pm('', { code_2: 'Syy2', river_2: 'Other Sample', comment_2: 'Below the sample dam', QUATERNARY: 'X00B', PESC: 'B: SAMPLE TEXT' }), name: 'ignored' },
				{ ...pm('', { NODE_CODE: 'Syz3', RESERVE: 'D' }), name: 'Syz3' },
				{ ...pm('', {}), name: 'Sxi1' }
			],
			[]
		);
		expect(r.nodes.map((n) => [n.id, n.label, n.basin, n.lon, n.lat, n.approx])).toEqual([
			['vaal-orange:syx1', 'Syx1', 'Sample Basin', 26.5, -28.1, false],
			['vaal-orange:syy2', 'Syy2', 'Sample Basin', 26.5, -28.1, false],
			['vaal-orange:syz3', 'Syz3', 'Sample Basin', 26.5, -28.1, false],
			['vaal-orange:sxi1', 'Sxi1', 'Sample Basin', 26.5, -28.1, false]
		]);
		const [a, b, c, d] = r.nodes;
		expect([a.river, a.comment, a.quat, a.pes, a.rec, a.tec, a.ecSource]).toEqual(['Sample River', 'At the sample weir', 'X00A', 'C', '', '', { pes: 'Node KML' }]);
		expect([b.river, b.comment, b.quat, b.pes]).toEqual(['Other Sample', 'Below the sample dam', 'X00B', 'B']);
		expect([c.rec, c.ecSource]).toEqual(['D', { rec: 'Node KML' }]);
		// The KML's role and an estuary code note why a node has no EWR, while it has none.
		expect(a.ewrNote).toBe('The node KML marks this as a gauge node.');
		expect(d.ewrNote).toBe('Estuary node. The supplied Desktop runs cover rivers only.');
		expect(r.report.nodesWithoutFiles).toEqual(r.nodes.map((n) => n.id));
		roundTrip(r);
	});

	it('reports placemarks that make no node: no code, a code that is not a key, a key already taken', () => {
		const r = match([pm('syx1'), pm('SYX1'), pm('***'), { ...pm(''), name: '' }, pm('s'.repeat(41))], []);
		expect(r.nodes.map((n) => n.id)).toEqual(['vaal-orange:syx1']);
		expect(r.report.placemarks.map((p) => [p.name, p.reason])).toEqual([
			['SYX1', 'Another placemark, syx1, is already node vaal-orange:syx1; this one is left out.'],
			['***', "*** can't be a node key: at most 40 letters, digits, '-' and '_'."],
			['', 'It has no name and no node code.'],
			['s'.repeat(41), `${'s'.repeat(41)} can't be a node key: at most 40 letters, digits, '-' and '_'.`]
		]);
	});

	it('carries the KML points parseKml skipped into the report', () => {
		const kmlSkipped = [{ name: 'Sample area', folder: null, reason: 'It is a polygon, not a point.' }];
		expect(matchUpload({ wma: WMA, basin: 'Sample Basin', placemarks: [], files: [], kmlSkipped }).report.kmlSkipped).toEqual(kmlSkipped);
	});
});

describe('matchUpload: files to nodes', () => {
	it('joins a file by its stem: the code in any case, an EC suffix, _DT and -i', () => {
		const r = match(
			[pm('Syx1', { reason: 'gauge' }), pm('syy2')],
			[
				['SYX1B.tab', tab('B', 2)],
				['syx1C.tab', tab('C', 3)],
				['syx1CD_DT.tab', tab('C/D', 4)],
				['syx1D-i.tab', tab('D', 5)],
				['Syx1.rul(NEWFORM)', 'Synthetic Revised run'],
				['syx1.nat', 'Synthetic natural flows'],
				['syx1C_Con.txt', tab('C', 3)]
			]
		);
		const n = node(r, 'syx1');
		expect(n.files).toEqual([
			{ name: 'SYX1B.tab', kind: 'tab', ec: 'B', basis: '' },
			{ name: 'Syx1.rul(NEWFORM)', kind: 'revised', ec: '', basis: '' },
			{ name: 'syx1.nat', kind: 'hydro', ec: '', basis: '' },
			{ name: 'syx1C.tab', kind: 'tab', ec: 'C', basis: '' },
			{ name: 'syx1CD_DT.tab', kind: 'tab', ec: 'C/D', basis: '', variant: true },
			{ name: 'syx1D-i.tab', kind: 'tab', ec: 'D', basis: '' }
		]);
		// The .tab ECs, and A to D from the Revised run.
		expect(n.ecsAvailable).toEqual(['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D']);
		expect([n.hasTab, n.hasRevised, n.ewrNote]).toEqual([true, true, '']);
		expect(r.report.nodesWithoutFiles).toEqual(['vaal-orange:syy2']);
		// A _Con.txt stem is not code + EC, so scan_named never joins one; nor does this.
		expect(r.report.unmatched).toEqual([{ file: 'syx1C_Con.txt', reason: 'no-node', detail: 'File name does not match a node code in the KML.' }]);
		expect(parseTab(r.texts[n.id]['syx1C.tab']).total[0]).toBe(3);
		roundTrip(r);
	});

	it('reports each file it cannot join, and why', () => {
		const r = match(
			[pm('syx1'), pm('syx1c'), pm('syy2')],
			[
				['syz9C.tab', tab('C', 1)],
				['syy2c.tab', tab('C', 1)],
				['syy2C.doc', 'Not a Desktop output'],
				['syx1C.tab', tab('C', 1)],
				['Sample notes.txt', 'A note'],
				['syy2.zip', 'PK'],
				['one/syy2C.tab', tab('C', 1)],
				['two/syy2C.tab', tab('C', 2)]
			]
		);
		expect(r.report.unmatched).toEqual([
			{ file: 'Sample notes.txt', reason: 'skipped', detail: 'A zip or a notes file, not a Desktop output.' },
			{ file: 'syx1C.tab', reason: 'ambiguous', detail: 'File name could be node vaal-orange:syx1 or vaal-orange:syx1c.' },
			{ file: 'syy2.zip', reason: 'skipped', detail: 'A zip or a notes file, not a Desktop output.' },
			{ file: 'syy2C.doc', reason: 'unknown-type', detail: 'Unknown file type.' },
			{ file: 'syy2C.tab', reason: 'duplicate', detail: 'Another file has this name; only the first is used.' },
			// An EC suffix is upper case, as NODE_RE has it, so a lower-case one is part of the code.
			{ file: 'syy2c.tab', reason: 'no-node', detail: 'File name does not match a node code in the KML.' },
			{ file: 'syz9C.tab', reason: 'no-node', detail: 'File name does not match a node code in the KML.' }
		]);
		expect(node(r, 'syy2').files.map((f) => f.name)).toEqual(['syy2C.tab']);
		expect(r.texts['vaal-orange:syy2']['syy2C.tab']).toBe(tab('C', 1));
		roundTrip(r);
	});

	it('reports a node with files but no .tab or Revised run', () => {
		const r = match([pm('syx1', { reason: 'IBT' })], [['syx1.nat', 'Synthetic natural flows']]);
		expect(r.report.nodesWithoutEwr).toEqual(['vaal-orange:syx1']);
		expect(node(r, 'syx1').ewrNote).toBe('The node KML marks this as an inter-basin transfer node.');
		roundTrip(r);
	});

	it('reads every file with universal newlines, as build_data.py does', () => {
		const r = match([pm('syx1')], [['syx1C.tab', tab('C', 1, '\r\n')]]);
		expect(r.texts['vaal-orange:syx1']['syx1C.tab']).toBe(tab('C', 1));
	});
});

describe('matchUpload: EC conflicts, as resolve_ec_conflicts decides them', () => {
	const r = match(
		['syx1', 'syx2', 'syx3', 'syx4', 'syx5', 'syx6', 'syx7', 'syx8'].map((c) => pm(c)),
		[
			// A copy of the run its header names: treated as that EC, and kept as a variant.
			['syx1C.tab', tab('C', 1)],
			['syx1D.tab', tab('C', 1)],
			// A distinct run with a stale header: the name's EC.
			['syx2C.tab', tab('C', 1)],
			['syx2D.tab', tab('C', 2)],
			// No run of the header's EC to compare with: also the name's EC.
			['syx3D.rul', tab('C', 1)],
			// An .mrv takes the name's EC with no note.
			['syx4D.mrv', tab('C', 1)],
			// No EC in the name: the header's.
			['syx5.tab', tab('B', 1)],
			// No EC in the header, no plain run: the name's.
			['syx6C.tab', tab(null, 1)],
			// The same run with other line ends is still a copy.
			['syx7C.tab', tab('C', 1)],
			['syx7D.tab', tab('C', 1, '\r\n')],
			// Name and header agree: nothing to decide.
			['syx8C.tab', tab('C', 1)]
		]
	);

	it('a copy of the header-EC twin is treated as the header EC, marked a variant, and noted', () => {
		expect(file(r, 'syx1', 'syx1D.tab')).toEqual({ name: 'syx1D.tab', kind: 'tab', ec: 'C', basis: '', variant: true, ecNote: 'Identical to the C run, so no D run exists; treated as C' });
		expect(file(r, 'syx1', 'syx1C.tab')).toEqual({ name: 'syx1C.tab', kind: 'tab', ec: 'C', basis: '' });
		expect(node(r, 'syx1').ecsAvailable).toEqual(['C']);
		expect(file(r, 'syx7', 'syx7D.tab').ec).toBe('C');
		expect(file(r, 'syx7', 'syx7D.tab').variant).toBe(true);
	});

	it('distinct values keep the file name EC, noted', () => {
		expect(file(r, 'syx2', 'syx2D.tab')).toEqual({ name: 'syx2D.tab', kind: 'tab', ec: 'D', basis: '', ecNote: 'Header says C but values are a distinct run; treated as D (file name)' });
		expect(node(r, 'syx2').ecsAvailable).toEqual(['C', 'D']);
		expect(file(r, 'syx3', 'syx3D.rul')).toMatchObject({ ec: 'D', ecNote: 'Header says C but values are a distinct run; treated as D (file name)' });
		expect(file(r, 'syx6', 'syx6C.tab')).toMatchObject({ ec: 'C', ecNote: 'Header gives no EC but values are a distinct run; treated as C (file name)' });
	});

	it('an .mrv takes the name EC with no note, and no stem EC keeps the header EC', () => {
		expect(file(r, 'syx4', 'syx4D.mrv')).toEqual({ name: 'syx4D.mrv', kind: 'mrv', ec: 'D', basis: '' });
		expect(file(r, 'syx5', 'syx5.tab')).toEqual({ name: 'syx5.tab', kind: 'tab', ec: 'B', basis: '' });
		expect(file(r, 'syx8', 'syx8C.tab')).toEqual({ name: 'syx8C.tab', kind: 'tab', ec: 'C', basis: '' });
	});

	it('reports each decision, and nothing where there was none to make', () => {
		expect(r.report.ecDecisions.map((d) => [d.file, d.kind, d.nameEc, d.headerEc, d.ec])).toEqual([
			['syx1D.tab', 'ec-copy', 'D', 'C', 'C'],
			['syx2D.tab', 'ec-header', 'D', 'C', 'D'],
			['syx3D.rul', 'ec-header', 'D', 'C', 'D'],
			['syx6C.tab', 'ec-header', 'C', '', 'C'],
			['syx7D.tab', 'ec-copy', 'D', 'C', 'C']
		]);
		roundTrip(r);
	});

	it('an admin can override a decision, and the node is worked out again', () => {
		const o = overrideEc(r, 'vaal-orange:syx1', 'syx1D.tab', 'd');
		expect(file(o, 'syx1', 'syx1D.tab')).toEqual({
			name: 'syx1D.tab',
			kind: 'tab',
			ec: 'D',
			basis: '',
			ecNote: 'Set by an admin: treated as D, where the file name says D and the header says C'
		});
		expect(node(o, 'syx1').ecsAvailable).toEqual(['C', 'D']);
		expect(o.report.ecDecisions.find((d) => d.file === 'syx1D.tab')).toMatchObject({ kind: 'admin', ec: 'D' });
		// The result it was given is left as it was.
		expect(file(r, 'syx1', 'syx1D.tab').ec).toBe('C');
		roundTrip(o);
		// Keeping the header's EC on a copy keeps it a variant.
		expect(file(overrideEc(r, 'vaal-orange:syx1', 'syx1D.tab', 'C'), 'syx1', 'syx1D.tab').variant).toBe(true);
	});

	it('an override can give a node its first EWR, and take it away', () => {
		const none = match([pm('syx1')], [['syx1.tab', tab(null, 1)]]);
		expect(none.report.nodesWithoutEwr).toEqual(['vaal-orange:syx1']);
		const set = overrideEc(none, 'vaal-orange:syx1', 'syx1.tab', 'B');
		expect([node(set, 'syx1').ecsAvailable, node(set, 'syx1').hasTab, set.report.nodesWithoutEwr]).toEqual([['B'], true, []]);
	});

	it('refuses an override of what is not there', () => {
		expect(() => overrideEc(r, 'vaal-orange:syx1', 'syx1D.tab', 'F')).toThrow('F is not an Ecological Category.');
		expect(() => overrideEc(r, 'vaal-orange:nope', 'syx1D.tab', 'C')).toThrow('vaal-orange:nope is not a node of this upload.');
		expect(() => overrideEc(r, 'vaal-orange:syx1', 'nope.tab', 'C')).toThrow('nope.tab is not a file of vaal-orange:syx1.');
	});
});

describe('attachFile and detachFile: an admin attaches by hand what no name matched', () => {
	// syx1 and syx1c make syx1C.tab ambiguous; syy2 has no file; syz9C.tab and syy2_Con.txt-style names match nothing.
	const base = () =>
		match(
			[pm('syx1'), pm('syx1c'), pm('syy2')],
			[
				['syx1C.tab', tab('C', 1)],
				['syx1D.tab', tab('C', 1)],
				['syz9C.tab', tab('B', 2)],
				['syz9.rul(NEWFORM)', 'Synthetic Revised run'],
				['notes on syz9.doc', 'Not a Desktop output'],
				['syy2 notes.txt', 'A note']
			]
		);

	it('keeps the text of each unmatched Desktop output, and only those, to attach', () => {
		const r = base();
		expect(attachable(r)).toEqual(['syx1C.tab', 'syz9.rul(NEWFORM)', 'syz9C.tab']);
		expect(r.loose['syz9C.tab']).toBe(tab('B', 2));
		expect(r.report.unmatched.map((u) => [u.file, u.reason])).toEqual([
			['notes on syz9.doc', 'no-node'],
			['syx1C.tab', 'ambiguous'],
			['syy2 notes.txt', 'skipped'],
			['syz9.rul(NEWFORM)', 'no-node'],
			['syz9C.tab', 'no-node']
		]);
		// With nothing in the folder under its name, syx1D.tab's header (C) has no twin, so its name decides.
		expect(file(r, 'syx1', 'syx1D.tab')).toMatchObject({ ec: 'D', ecNote: 'Header says C but values are a distinct run; treated as D (file name)' });
	});

	it('gives a node with no data the file, its EC from the header, and says an admin attached it', () => {
		const r = base();
		const a = attachFile(r, 'vaal-orange:syy2', 'syz9C.tab');
		expect(node(a, 'syy2').files).toEqual([{ name: 'syz9C.tab', kind: 'tab', ec: 'B', basis: '', ecNote: 'Attached by an admin.' }]);
		expect([node(a, 'syy2').ecsAvailable, node(a, 'syy2').hasTab]).toEqual([['B'], true]);
		expect(a.texts['vaal-orange:syy2']).toEqual({ 'syz9C.tab': tab('B', 2) });
		expect(a.report.nodesWithoutFiles).toEqual(['vaal-orange:syx1c']);
		expect(a.report.unmatched.map((u) => u.file)).not.toContain('syz9C.tab');
		expect(attachable(a)).toEqual(['syx1C.tab', 'syz9.rul(NEWFORM)']);
		expect(a.report.files.at(-1)).toEqual({ nodeId: 'vaal-orange:syy2', file: 'syz9C.tab', kind: 'tab', nameEc: '', headerEc: 'B', dt: false, copy: false, attached: true });
		// The result it was given is left as it was.
		expect(node(r, 'syy2').files).toEqual([]);
		expect(attachable(r)).toContain('syz9C.tab');
		roundTrip(a);

		const b = attachFile(a, 'vaal-orange:syy2', 'syz9.rul(NEWFORM)');
		expect(node(b, 'syy2').ecsAvailable).toEqual(['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D']);
		expect(file(b, 'syy2', 'syz9.rul(NEWFORM)')).toEqual({ name: 'syz9.rul(NEWFORM)', kind: 'revised', ec: '', basis: '', ecNote: 'Attached by an admin.' });
		// Kept in name order, as the build lists a folder.
		expect(node(b, 'syy2').files.map((f) => f.name)).toEqual(['syz9.rul(NEWFORM)', 'syz9C.tab']);
		roundTrip(b);
	});

	it('reads an EC from the name only where the name is the node code plus a suffix', () => {
		const r = base();
		const a = attachFile(r, 'vaal-orange:syx1c', 'syx1C.tab');
		expect(a.report.files.find((f) => f.file === 'syx1C.tab')).toMatchObject({ nameEc: '', headerEc: 'C' });
		expect(file(a, 'syx1c', 'syx1C.tab')).toEqual({ name: 'syx1C.tab', kind: 'tab', ec: 'C', basis: '', ecNote: 'Attached by an admin.' });
		const b = attachFile(r, 'vaal-orange:syx1', 'syx1C.tab');
		expect(b.report.files.find((f) => f.file === 'syx1C.tab')).toMatchObject({ nameEc: 'C', headerEc: 'C' });
	});

	it("decides the node's EC conflicts again, as the build would with the file under the node's name", () => {
		const a = attachFile(base(), 'vaal-orange:syx1', 'syx1C.tab');
		// syx1D.tab now has a C run to compare with, of the same values: a copy, so C and a variant.
		expect(file(a, 'syx1', 'syx1D.tab')).toEqual({ name: 'syx1D.tab', kind: 'tab', ec: 'C', basis: '', variant: true, ecNote: 'Identical to the C run, so no D run exists; treated as C' });
		expect(node(a, 'syx1').ecsAvailable).toEqual(['C']);
		expect(a.report.ecDecisions.map((d) => [d.file, d.kind, d.ec])).toEqual([['syx1D.tab', 'ec-copy', 'C']]);
		expect(a.report.files.find((f) => f.file === 'syx1D.tab')?.copy).toBe(true);
		roundTrip(a);

		// Taken off again, the node is as matchUpload left it.
		const d = detachFile(a, 'vaal-orange:syx1', 'syx1C.tab');
		expect(node(d, 'syx1')).toEqual(node(base(), 'syx1'));
		expect(d.report.ecDecisions).toEqual(base().report.ecDecisions);
		roundTrip(d);
	});

	it("keeps an EC an admin set through the node's conflicts being decided again", () => {
		const o = overrideEc(base(), 'vaal-orange:syx1', 'syx1D.tab', 'D');
		const a = attachFile(o, 'vaal-orange:syx1', 'syx1C.tab');
		expect(file(a, 'syx1', 'syx1D.tab')).toEqual({ name: 'syx1D.tab', kind: 'tab', ec: 'D', basis: '', ecNote: 'Set by an admin: treated as D, where the file name says D and the header says C' });
		expect(a.report.ecDecisions.map((d) => [d.file, d.kind, d.ec])).toEqual([['syx1D.tab', 'admin', 'D']]);
		expect(node(a, 'syx1').ecsAvailable).toEqual(['C', 'D']);
	});

	it('keeps saying a file was attached when an admin then sets its EC', () => {
		const a = overrideEc(attachFile(base(), 'vaal-orange:syy2', 'syz9C.tab'), 'vaal-orange:syy2', 'syz9C.tab', 'C');
		expect(file(a, 'syy2', 'syz9C.tab').ecNote).toBe('Attached by an admin. Set by an admin: treated as C, where the header says B');
		roundTrip(a);
	});

	it('detaches any file back to the unmatched files, from where it can go to another node', () => {
		const r = base();
		const d = detachFile(r, 'vaal-orange:syx1', 'syx1D.tab');
		expect(node(d, 'syx1').files).toEqual([]);
		expect(d.texts['vaal-orange:syx1']).toBeUndefined();
		expect(d.report.nodesWithoutFiles).toEqual(['vaal-orange:syx1', 'vaal-orange:syx1c', 'vaal-orange:syy2']);
		expect(d.report.unmatched.find((u) => u.file === 'syx1D.tab')).toEqual({ file: 'syx1D.tab', reason: 'detached', detail: 'Taken off node vaal-orange:syx1 by an admin.' });
		expect(d.report.ecDecisions).toEqual([]);
		expect(d.report.files.map((f) => f.file)).not.toContain('syx1D.tab');
		roundTrip(d);

		const a = attachFile(d, 'vaal-orange:syy2', 'syx1D.tab');
		expect(file(a, 'syy2', 'syx1D.tab')).toEqual({ name: 'syx1D.tab', kind: 'tab', ec: 'C', basis: '', ecNote: 'Attached by an admin.' });
		expect(a.report.unmatched.map((u) => u.file)).not.toContain('syx1D.tab');
		roundTrip(a);
	});

	it('works out the limits again', () => {
		const many = Array.from({ length: 40 }, (_, i) => [`syx1C${String(i).padStart(2, '0')}.nat`, 'Synthetic natural flows'] as [string, string]);
		// A stem of `syx1C00` is no node's code, so these all go unmatched: attach them by hand.
		let r = match([pm('syx1')], [...many, ['syx1.nat', 'Synthetic natural flows']]);
		for (const [name] of many) r = attachFile(r, 'vaal-orange:syx1', name);
		expect(r.report.overLimits).toEqual([{ nodeId: 'vaal-orange:syx1', detail: '41 files; a node holds at most 40.' }]);
		r = detachFile(r, 'vaal-orange:syx1', 'syx1.nat');
		expect(r.report.overLimits).toEqual([]);
	});

	it('refuses what is not there, or cannot be attached', () => {
		const r = base();
		expect(() => attachFile(r, 'vaal-orange:nope', 'syz9C.tab')).toThrow('vaal-orange:nope is not a node of this upload.');
		expect(() => attachFile(r, 'vaal-orange:syy2', 'notes on syz9.doc')).toThrow('notes on syz9.doc is not an unmatched file that can be attached.');
		expect(() => attachFile(r, 'vaal-orange:syy2', 'syx1D.tab')).toThrow('syx1D.tab is not an unmatched file that can be attached.');
		expect(() => detachFile(r, 'vaal-orange:syy2', 'syx1D.tab')).toThrow('syx1D.tab is not a file of vaal-orange:syy2.');
		expect(() => detachFile(r, 'vaal-orange:nope', 'syx1D.tab')).toThrow('vaal-orange:nope is not a node of this upload.');
	});
});
