// An admin's upload (#17), matched into the node store's format: the node KML's placemarks become
// nodes, and each Desktop output file joins the node its name gives. Pure: no DOM, no fetch.
//
// It is a port of what the private repo's tools/build_data.py decides for the built-in data, and must
// decide alike (CLAUDE.md § Domain rules): `classify`, `file_ec`, `norm_ec`, `tab_values`,
// `resolve_ec_conflicts`, and the file stem of `scan_named` (node code, then an optional EC suffix,
// `_DT` and `-i`). Where build_data.py knows a basin's code pattern (NODE_RE), this takes the codes
// from the KML instead, matched case-insensitively. Its hand-kept tables of one basin's files and
// sites are not ported: those are judgements about the supplied data, not rules.
import type { Placemark, KmlSkip } from './kml.ts';
import { NODE_KEY, NODE_STORE_LIMITS, type NodeTexts } from './nodeStore.ts';
import { LADDER } from './parsers.ts';
import type { EwrNode, FileKind, NodeFile } from './types.ts';

/** What an admin loads: a WMA, the basin its nodes are in, the node KML's points and the folder's files, as text. */
export interface UploadInput {
	wma: string;
	basin: string;
	placemarks: Placemark[];
	files: { name: string; text: string }[];
	/** The KML's placemarks with no point (`parseKml`'s `skipped`), to carry into the report. */
	kmlSkipped?: KmlSkip[];
}

export type UnmatchedReason = 'no-node' | 'ambiguous' | 'unknown-type' | 'skipped' | 'duplicate';

/** How a file's EC was decided when its name and its header disagree: as resolve_ec_conflicts does, or by an admin. */
export interface EcDecision {
	nodeId: string;
	file: string;
	/** ec-copy: the same values as the run its header names, so treated as that EC and kept as a variant. ec-header: a distinct run, so the name's EC. admin: an admin's override. */
	kind: 'ec-copy' | 'ec-header' | 'admin';
	/** The EC in the file name, and the EC in its header ('' when it has none). */
	nameEc: string;
	headerEc: string;
	ec: string;
	detail: string;
}

/** One matched file, as the preview lists it. */
export interface MatchedFile {
	nodeId: string;
	file: string;
	kind: FileKind;
	nameEc: string;
	headerEc: string;
	/** `_DT` in its name: an alternate run. */
	dt: boolean;
	/** The same values as the run its header names (ec-copy). */
	copy: boolean;
}

export interface UploadReport {
	files: MatchedFile[];
	/** Files that join no node, and why. */
	unmatched: { file: string; reason: UnmatchedReason; detail: string }[];
	ecDecisions: EcDecision[];
	/** Placemarks with a point that make no node: no code, a code that can't be a key, or a key another placemark has. */
	placemarks: { name: string; folder: string | null; reason: string }[];
	/** Placemarks with no point, from parseKml. */
	kmlSkipped: KmlSkip[];
	/** Ids of nodes no file joined, and of nodes with files but no .tab or Revised .rul. */
	nodesWithoutFiles: string[];
	nodesWithoutEwr: string[];
	/** Nodes over the store's limits, which the API would refuse. */
	overLimits: { nodeId: string; detail: string }[];
	/** The KML's role note of each node, kept so an override can work out ewrNote again. */
	roleNotes: Record<string, string>;
}

export interface UploadResult {
	nodes: EwrNode[];
	texts: Record<string, NodeTexts>;
	report: UploadReport;
}

// ---- build_data.py's file reading, ported ----------------------------------------------

/** norm_ec: 'cd', 'C/D' and 'C D' are all C/D; anything off the ladder is ''. */
export function normEc(s: string | null | undefined): string {
	let v = (s ?? '').trim().toUpperCase().replaceAll(' ', '');
	if (/^[A-E]{2}$/.test(v)) v = `${v[0]}/${v[1]}`;
	return LADDER.includes(v) ? v : '';
}

/** clean: whitespace runs to one space, trimmed. */
const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** file_ec: the EC a Desktop output's header gives, or ''. */
export function fileEc(text: string): string {
	const m =
		/Ecological Category\s*=\s*([A-E/]+)/.exec(text) ?? /Ecological Category\s+([A-E/]+)/.exec(text) ?? /Reserve Requirement for\s+([A-E/]+)\s+Generic/.exec(text);
	return m ? normEc(m[1]) : '';
}

const HYDRO_EXT = new Set(['.nat', '.pd', '.inc', '.cur']);

/** classify: a file's kind by its name, or '' when it is not a Desktop output. */
export function classify(name: string): FileKind | '' {
	const low = name.toLowerCase();
	if (low.includes('.rul(newform)')) return 'revised';
	// os.path.splitext: the last dot, unless the name starts with it.
	const dot = low.lastIndexOf('.');
	const ext = dot > 0 ? low.slice(dot) : '';
	if (ext === '.tab') return 'tab';
	if (ext === '.rul') return 'rul';
	if (ext === '.mrv') return 'mrv';
	if (low.endsWith('_con.txt')) return 'con';
	return HYDRO_EXT.has(ext) ? 'hydro' : '';
}

/** tab_values: the text after each month name that starts a line, which is what makes two runs the same run. */
export function tabValues(text: string): string[] {
	return [...text.matchAll(/(?<![^\n])\s*(?:Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)\s+([^\n]*)/g)].map((m) => m[1]);
}

/** Python's universal newlines, as build_data.py reads every file: \r\n and \r become \n. */
const universalNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

interface Found {
	name: string;
	kind: FileKind;
	nodeId: string;
	text: string;
	stemEc: string;
	ec: string;
	variant: boolean;
	duplicate?: boolean;
	note?: string;
}

/**
 * resolve_ec_conflicts: where a file's name and header disagree on the EC, the values decide. A file
 * with the same values as the sibling run named for its header EC is a copy of that run, so the EC in
 * its name was never produced: it keeps the header EC and is marked a duplicate. Otherwise it is a
 * distinct run whose header was left stale, and takes the name's EC. An .mrv gets no note.
 */
function resolveEcConflicts(found: Found[], decisions: EcDecision[]): void {
	const byName = new Map<string, Found>();
	const at = (node: string, ec: string, kind: string) => JSON.stringify([node, ec, kind]);
	for (const f of found) byName.set(at(f.nodeId, f.stemEc, f.kind), f);
	for (const f of found) {
		if (!['tab', 'rul', 'mrv'].includes(f.kind) || !f.stemEc || f.ec === f.stemEc) continue;
		const twin = byName.get(at(f.nodeId, f.ec, f.kind));
		const headerEc = f.ec;
		if (twin !== undefined && sameValues(tabValues(twin.text), tabValues(f.text))) {
			const detail = `Identical to the ${f.ec || 'unnamed'} run, so no ${f.stemEc} run exists; treated as ${f.ec || 'no EC'}`;
			f.duplicate = true;
			f.note = detail;
			decisions.push({ nodeId: f.nodeId, file: f.name, kind: 'ec-copy', nameEc: f.stemEc, headerEc, ec: f.ec, detail });
		} else {
			f.ec = f.stemEc;
			if (f.kind !== 'mrv') {
				const detail = `${headerEc ? `Header says ${headerEc}` : 'Header gives no EC'} but values are a distinct run; treated as ${f.stemEc} (file name)`;
				f.note = detail;
				decisions.push({ nodeId: f.nodeId, file: f.name, kind: 'ec-header', nameEc: f.stemEc, headerEc, ec: f.ec, detail });
			}
		}
	}
}

const sameValues = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- placemarks to nodes -----------------------------------------------------------------

/** Where the supplied KMLs keep a node's code, river, comment, quaternary and ECs, case aside. */
const FIELDS = {
	code: ['NODE', 'code_2', 'code', 'NODE_CODE'],
	river: ['RIVER', 'river_2', 'RIVER_NAME'],
	comment: ['COMMENT', 'comment_2'],
	quat: ['QUAT', 'QUATERNARY'],
	pes: ['PES', 'PESC'],
	rec: ['REC', 'RESERVE'],
	tec: ['TEC']
} as const;

function field(data: Record<string, string>, names: readonly string[]): string {
	const lower = new Map(Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]));
	for (const n of names) {
		const v = lower.get(n.toLowerCase());
		if (v?.trim()) return v;
	}
	return '';
}

/** A placemark's node code: the KML's NODE (or code_2, code, NODE_CODE) field, as the supplied KMLs carry it, else its name. */
export const placemarkCode = (p: Placemark) => clean(field(p.data, FIELDS.code) || p.name);

/** A node code as a store key: lowercase, anything but letters, digits, '-' and '_' made '-'. Null when that is not a key. */
export function codeKey(code: string): string | null {
	const key = code
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[-_]+|-+$/g, '');
	return NODE_KEY.test(key) ? key : null;
}

const KML_ROLE: Record<string, string> = {
	gauge: 'The node KML marks this as a gauge node.',
	IBT: 'The node KML marks this as an inter-basin transfer node.'
};
const ESTUARY_NOTE = 'Estuary node. The supplied Desktop runs cover rivers only.';

function placemarkNode(p: Placemark, id: string, code: string, basin: string): EwrNode {
	// PESC reads "C: MODERATELY MODIFIED", so the EC is before the colon.
	const pes = normEc(field(p.data, FIELDS.pes).split(':')[0]);
	const rec = normEc(field(p.data, FIELDS.rec).split(':')[0]);
	const tec = normEc(field(p.data, FIELDS.tec).split(':')[0]);
	const ecSource: Record<string, string> = {};
	if (pes) ecSource.pes = 'Node KML';
	if (rec) ecSource.rec = 'Node KML';
	if (tec) ecSource.tec = 'Node KML';
	return {
		id,
		label: code,
		basin,
		quat: clean(field(p.data, FIELDS.quat)),
		river: clean(field(p.data, FIELDS.river)),
		comment: clean(field(p.data, FIELDS.comment)),
		lon: p.lon,
		lat: p.lat,
		approx: false,
		pes,
		rec,
		tec,
		tecInc: '',
		tecCum: '',
		iua: '',
		ewrClass: '',
		ru: '',
		ewrBasis: '',
		ewrNote: '',
		gazPct: null,
		sites: [],
		ecSource,
		files: [],
		ecsAvailable: [],
		hasTab: false,
		hasRevised: false
	};
}

/** ecsAvailable, hasTab, hasRevised and ewrNote from the node's files, as build_data.py finishes a node. */
function finish(n: EwrNode, roleNote: string): void {
	const tab = [...new Set(n.files.filter((f) => (f.kind === 'tab' || f.kind === 'con') && LADDER.includes(f.ec)).map((f) => f.ec))];
	const revised = n.files.some((f) => f.kind === 'revised') ? LADDER.slice(0, 7) : [];
	n.ecsAvailable = [...new Set([...tab, ...revised])].sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b));
	n.hasTab = tab.length > 0;
	n.hasRevised = revised.length > 0;
	n.ewrNote = n.ecsAvailable.length ? '' : /:[a-z]xi\d/.test(n.id) ? roleNote || ESTUARY_NOTE : roleNote;
}

// ---- file names to nodes -----------------------------------------------------------------

const STEM_EC = ['AB', 'BC', 'CD', 'DE', 'A', 'B', 'C', 'D', 'E'];

/**
 * The nodes a file stem can name: code + optional EC suffix (upper case, as NODE_RE has it) + optional
 * `_DT` + optional `-i`, the code matched to a node case-insensitively. Each reading that names a node.
 */
function stemReadings(stem: string, codes: Map<string, string>): { nodeId: string; stemEc: string; dt: boolean }[] {
	const out: { nodeId: string; stemEc: string; dt: boolean }[] = [];
	for (const dash of [true, false]) {
		if (dash && !stem.endsWith('-i')) continue;
		const s1 = dash ? stem.slice(0, -2) : stem;
		for (const dt of [true, false]) {
			if (dt && !s1.endsWith('_DT')) continue;
			const s2 = dt ? s1.slice(0, -3) : s1;
			for (const ec of [...STEM_EC, '']) {
				if (ec && !s2.endsWith(ec)) continue;
				const code = s2.slice(0, s2.length - ec.length).toLowerCase();
				const nodeId = codes.get(code);
				if (code && nodeId) out.push({ nodeId, stemEc: normEc(ec), dt });
			}
		}
	}
	return out;
}

// eslint-disable-next-line no-control-regex
const UNSTORABLE = /[\u0000-\u001f\u007f]/;

/** Match an admin's node KML and folder of Desktop outputs into the node store's format, with a report for the preview. */
export function matchUpload({ wma, basin, placemarks, files, kmlSkipped = [] }: UploadInput): UploadResult {
	const report: UploadReport = {
		files: [],
		unmatched: [],
		ecDecisions: [],
		placemarks: [],
		kmlSkipped: [...kmlSkipped],
		nodesWithoutFiles: [],
		nodesWithoutEwr: [],
		overLimits: [],
		roleNotes: {}
	};

	// Placemarks to nodes. The first placemark with a key keeps it; a later one is reported.
	const nodes: EwrNode[] = [];
	const byKey = new Map<string, { node: EwrNode; name: string }>();
	const codes = new Map<string, string>();
	for (const p of placemarks) {
		const code = placemarkCode(p);
		const shown = code || p.name;
		if (!code) {
			report.placemarks.push({ name: shown, folder: p.folder, reason: 'It has no name and no node code.' });
			continue;
		}
		const key = codeKey(code);
		if (key === null) {
			report.placemarks.push({ name: shown, folder: p.folder, reason: `${code} can't be a node key: at most 40 letters, digits, '-' and '_'.` });
			continue;
		}
		const had = byKey.get(key);
		if (had) {
			report.placemarks.push({ name: shown, folder: p.folder, reason: `Another placemark, ${had.name}, is already node ${had.node.id}; this one is left out.` });
			continue;
		}
		const node = placemarkNode(p, `${wma}:${key}`, code, basin);
		nodes.push(node);
		byKey.set(key, { node, name: shown });
		const role = field(p.data, ['reason']).trim();
		report.roleNotes[node.id] = Object.hasOwn(KML_ROLE, role) ? KML_ROLE[role] : '';
		for (const c of [code.toLowerCase(), key]) if (!codes.has(c)) codes.set(c, node.id);
	}

	// Files to nodes, in name order as build_data.py lists a folder.
	const found: Found[] = [];
	const seen = new Set<string>();
	const sorted = files
		.map((f) => ({ name: f.name.slice(Math.max(f.name.lastIndexOf('/'), f.name.lastIndexOf('\\')) + 1), text: f.text }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const { name, text } of sorted) {
		const low = name.toLowerCase();
		if (low.endsWith('.zip') || low.endsWith('notes.txt')) {
			report.unmatched.push({ file: name, reason: 'skipped', detail: 'A zip or a notes file, not a Desktop output.' });
			continue;
		}
		if (!name || name.length > 120 || UNSTORABLE.test(name) || name === '.' || name === '..') {
			report.unmatched.push({ file: name, reason: 'skipped', detail: 'The file name is too long, or has characters a name cannot keep.' });
			continue;
		}
		if (seen.has(name)) {
			report.unmatched.push({ file: name, reason: 'duplicate', detail: 'Another file has this name; only the first is used.' });
			continue;
		}
		seen.add(name);
		const stem = name.split('.')[0];
		const readings = stemReadings(stem, codes);
		const ids = [...new Set(readings.map((r) => r.nodeId))];
		if (ids.length === 0) {
			report.unmatched.push({ file: name, reason: 'no-node', detail: 'File name does not match a node code in the KML.' });
			continue;
		}
		if (ids.length > 1) {
			report.unmatched.push({ file: name, reason: 'ambiguous', detail: `File name could be node ${ids.join(' or ')}.` });
			continue;
		}
		const kind = classify(name);
		if (!kind) {
			report.unmatched.push({ file: name, reason: 'unknown-type', detail: 'Unknown file type.' });
			continue;
		}
		const { nodeId, stemEc, dt } = readings[0];
		const body = universalNewlines(text);
		found.push({ name, kind, nodeId, text: body, stemEc, variant: dt, ec: kind === 'tab' || kind === 'rul' || kind === 'mrv' ? fileEc(body) : '' });
	}
	const headerEc = new Map(found.map((f) => [f, f.ec]));
	resolveEcConflicts(found, report.ecDecisions);

	// Attach, and finish each node.
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const texts: Record<string, NodeTexts> = {};
	for (const f of found) {
		const n = byId.get(f.nodeId) as EwrNode;
		const file: NodeFile = { name: f.name, kind: f.kind, ec: f.ec, basis: '' };
		if (f.variant || f.duplicate) file.variant = true;
		if (f.note) file.ecNote = f.note;
		n.files.push(file);
		(texts[n.id] ??= {})[f.name] = f.text;
		report.files.push({ nodeId: n.id, file: f.name, kind: f.kind, nameEc: f.stemEc, headerEc: headerEc.get(f) ?? '', dt: f.variant, copy: f.duplicate === true });
	}
	for (const n of nodes) {
		finish(n, report.roleNotes[n.id]);
		if (!n.files.length) report.nodesWithoutFiles.push(n.id);
		else if (!n.ecsAvailable.length) report.nodesWithoutEwr.push(n.id);
	}
	report.overLimits = limits(nodes, texts);
	return { nodes, texts, report };
}

function limits(nodes: EwrNode[], texts: Record<string, NodeTexts>): UploadReport['overLimits'] {
	const L = NODE_STORE_LIMITS;
	const out: UploadReport['overLimits'] = [];
	if (nodes.length > L.nodesPerWma) out.push({ nodeId: '', detail: `${nodes.length} nodes; a WMA holds at most ${L.nodesPerWma}.` });
	for (const n of nodes) {
		const t = Object.values(texts[n.id] ?? {});
		if (n.files.length > L.filesPerNode) out.push({ nodeId: n.id, detail: `${n.files.length} files; a node holds at most ${L.filesPerNode}.` });
		const long = n.files.filter((f) => (texts[n.id]?.[f.name].length ?? 0) > L.fileChars);
		for (const f of long) out.push({ nodeId: n.id, detail: `${f.name} is longer than ${L.fileChars} characters.` });
		if (t.reduce((s, x) => s + x.length, 0) > L.nodeChars) out.push({ nodeId: n.id, detail: `Its files together are longer than ${L.nodeChars} characters.` });
		for (const k of ['label', 'river', 'comment', 'quat'] as const) {
			if (n[k].length > L.textChars) out.push({ nodeId: n.id, detail: `Its ${k} is longer than ${L.textChars} characters.` });
		}
	}
	return out;
}

/**
 * An admin's choice of a file's EC, over what the match decided. Returns a new result: the file's EC
 * and note, the decision, and the node's ECs worked out again. Throws when the node, the file or the EC is not one.
 */
export function overrideEc(result: UploadResult, nodeId: string, fileName: string, ec: string): UploadResult {
	const want = normEc(ec);
	if (!want) throw new Error(`${ec} is not an Ecological Category.`);
	const node = result.nodes.find((n) => n.id === nodeId);
	if (!node) throw new Error(`${nodeId} is not a node of this upload.`);
	const file = node.files.find((f) => f.name === fileName);
	if (!file) throw new Error(`${fileName} is not a file of ${nodeId}.`);
	if (file.kind === 'revised' || file.kind === 'hydro') throw new Error(`${fileName} has no single EC to set.`);
	const meta = result.report.files.find((f) => f.nodeId === nodeId && f.file === fileName);
	const nameEc = meta?.nameEc ?? '';
	const headerEc = meta?.headerEc ?? '';
	const said = [nameEc && `the file name says ${nameEc}`, headerEc ? `the header says ${headerEc}` : 'the header gives no EC'].filter(Boolean).join(' and ');
	const detail = `Set by an admin: treated as ${want}, where ${said}`;
	// Still a copy only if the admin kept the header's EC on a file found to be one; an alternate run stays a variant.
	const variant = (meta?.dt ?? false) || ((meta?.copy ?? false) && want === headerEc);

	const nodes = result.nodes.map((n) => {
		if (n.id !== nodeId) return n;
		const next: EwrNode = {
			...n,
			files: n.files.map((f) => {
				if (f.name !== fileName) return f;
				const g: NodeFile = { name: f.name, kind: f.kind, ec: want, basis: f.basis, ecNote: detail };
				if (variant) g.variant = true;
				return g;
			})
		};
		finish(next, result.report.roleNotes[n.id] ?? '');
		return next;
	});
	const ecDecisions = [
		...result.report.ecDecisions.filter((d) => !(d.nodeId === nodeId && d.file === fileName)),
		{ nodeId, file: fileName, kind: 'admin' as const, nameEc, headerEc, ec: want, detail }
	];
	const after = nodes.find((n) => n.id === nodeId) as EwrNode;
	const nodesWithoutEwr = result.report.nodesWithoutEwr.filter((id) => id !== nodeId);
	if (after.files.length && !after.ecsAvailable.length) nodesWithoutEwr.push(nodeId);
	return { nodes, texts: result.texts, report: { ...result.report, ecDecisions, nodesWithoutEwr } };
}
