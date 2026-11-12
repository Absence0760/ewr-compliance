// The admin node store (#17): EWR nodes an admin loads on the site, served from this site under
// nodes-data/ and merged over data/index.json. One format, checked here, for all three that touch
// it: the API checks every write against it (server/), the import panel writes it, and the app
// reads it. Pure: no DOM, no fetch. The files are described in docs/architecture.md § Node store.
//
//   nodes-data/index.json                 which WMAs have an overlay
//   nodes-data/wma-<wma>.json             a WMA's nodes and the built-in nodes it hides
//   nodes-data/files/<wma>/<key>.json     one node's Desktop outputs, by file name, as text
//
// A node's files are kept apart from the WMA's file so the map loads the nodes alone, and a node's
// text only when it is opened, as ewr-<basin>.json is for the built-in nodes.
import { LADDER } from './parsers.ts';
import type { EwrNode, FileKind, NodeFile } from './types.ts';

/** The one format version this app reads. A store written in another is refused, not guessed at. */
export const NODE_STORE_VERSION = 1;

/** What one write may hold. A WMA's files go up node by node, so each request stays far under the API's 6 MB. */
export const NODE_STORE_LIMITS = {
	nodesPerWma: 1000,
	deletedPerWma: 5000,
	filesPerNode: 40,
	/** Characters of one file's text. The largest supplied Desktop output is about a tenth of this. */
	fileChars: 1_000_000,
	/** Characters of all of one node's texts together. */
	nodeChars: 4_000_000,
	/** Characters of a short text field: label, river, comment and the like. */
	textChars: 500
} as const;

/**
 * The six WMAs' slugs, in their gazetted order: the same as `WMAS` in
 * src/lib/components/map/wma.ts (nodeStore.test.ts checks), kept here as well so the API, which
 * imports this file, needn't bundle the map's module.
 */
export const WMA_SLUGS = ['limpopo-olifants', 'inkomati-usuthu', 'pongola-mtamvuna', 'vaal-orange', 'mzimvubu-tsitsikamma', 'breede-olifants'] as const;

/** An uploaded node's id is `<wma>:<key>`, and its key names its files' object, so it is kept to a safe path segment. */
export const NODE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const WMA_SLUG = /^[a-z][a-z-]{1,39}$/;
const FILE_KINDS: readonly FileKind[] = ['tab', 'con', 'rul', 'revised', 'mrv', 'hydro'];
// No path separators, no control characters, not a dot name: a file name is only ever a key in a JSON object, but it is shown.
// eslint-disable-next-line no-control-regex
const FILE_NAME = /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,120}$/;

/** One WMA in nodes-data/index.json. */
export interface NodeStoreWma {
	/** When its file was last written, ISO 8601 with its offset. */
	updatedAt: string;
	/** How many uploaded nodes, and how many built-in nodes it hides. */
	nodes: number;
	deleted: number;
}

/** nodes-data/index.json: the WMAs that have a wma-<wma>.json. */
export interface NodeStoreIndex {
	version: number;
	wmas: Record<string, NodeStoreWma>;
}

/** nodes-data/wma-<wma>.json. */
export interface WmaOverlay {
	version: number;
	wma: string;
	updatedAt: string;
	/** Uploaded nodes. One with the id of a built-in node replaces it. */
	nodes: EwrNode[];
	/** Ids of built-in nodes an admin deleted, hidden until restored. */
	deleted: string[];
}

/** nodes-data/files/<wma>/<key>.json: a node's Desktop outputs, by file name. */
export type NodeTexts = Record<string, string>;

export const nodeStorePath = {
	index: 'nodes-data/index.json',
	wma: (wma: string) => `nodes-data/wma-${wma}.json`,
	files: (wma: string, key: string) => `nodes-data/files/${wma}/${key}.json`
} as const;

/** The bucket key of a served path: CloudFront serves serve/nodes-data/* at nodes-data/* (infra/nodes.tf). */
export const nodeStoreKey = (path: string) => `serve/${path}`;

/** An uploaded node's key, from its id `<wma>:<key>`; null when the id is not one. */
export function nodeKey(id: string, wma: string): string | null {
	const prefix = `${wma}:`;
	if (!id.startsWith(prefix)) return null;
	const key = id.slice(prefix.length);
	return NODE_KEY.test(key) ? key : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T\d{2}:\d{2}/.test(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** nodes-data/index.json checked against its format. Throws, naming what is wrong. */
export function parseNodeStoreIndex(json: unknown, wmas: readonly string[]): NodeStoreIndex {
	const where = nodeStorePath.index;
	if (!isObject(json)) throw new Error(`${where} is not a JSON object.`);
	if (json.version !== NODE_STORE_VERSION) throw new Error(`${where} is format version ${String(json.version)}; this app reads ${NODE_STORE_VERSION}.`);
	if (!isObject(json.wmas)) throw new Error(`${where} has no wmas.`);
	const out: Record<string, NodeStoreWma> = {};
	for (const [wma, e] of Object.entries(json.wmas)) {
		if (!wmas.includes(wma)) throw new Error(`${where}: ${wma} is not a WMA.`);
		if (!isObject(e) || !isTime(e.updatedAt) || !isCount(e.nodes) || !isCount(e.deleted)) {
			throw new Error(`${where}: ${wma} needs updatedAt, nodes and deleted.`);
		}
		out[wma] = { updatedAt: e.updatedAt, nodes: e.nodes, deleted: e.deleted };
	}
	return { version: NODE_STORE_VERSION, wmas: out };
}

/** nodes-data/wma-<wma>.json checked against its format, for the WMA it is meant to be. Throws, naming what is wrong. */
export function parseWmaOverlay(json: unknown, wma: string, wmas: readonly string[]): WmaOverlay {
	if (!WMA_SLUG.test(wma) || !wmas.includes(wma)) throw new Error(`${wma} is not a WMA.`);
	const where = nodeStorePath.wma(wma);
	if (!isObject(json)) throw new Error(`${where} is not a JSON object.`);
	if (json.version !== NODE_STORE_VERSION) throw new Error(`${where} is format version ${String(json.version)}; this app reads ${NODE_STORE_VERSION}.`);
	if (json.wma !== wma) throw new Error(`${where} is for ${String(json.wma)}, not ${wma}.`);
	if (!isTime(json.updatedAt)) throw new Error(`${where} has no updatedAt time.`);
	if (!Array.isArray(json.nodes)) throw new Error(`${where} has no nodes.`);
	if (!Array.isArray(json.deleted)) throw new Error(`${where} has no deleted list.`);
	if (json.nodes.length > NODE_STORE_LIMITS.nodesPerWma) throw new Error(`${where} has more than ${NODE_STORE_LIMITS.nodesPerWma} nodes.`);
	if (json.deleted.length > NODE_STORE_LIMITS.deletedPerWma) throw new Error(`${where} hides more than ${NODE_STORE_LIMITS.deletedPerWma} nodes.`);
	const nodes = json.nodes.map((n, i) => parseNode(n, wma, `${where}: node ${i + 1}`));
	const ids = new Set<string>();
	for (const n of nodes) {
		if (ids.has(n.id)) throw new Error(`${where}: ${n.id} is there twice.`);
		ids.add(n.id);
	}
	const deleted = json.deleted.map((id, i) => {
		if (typeof id !== 'string' || !id || id.length > NODE_STORE_LIMITS.textChars) throw new Error(`${where}: deleted ${i + 1} is not a node id.`);
		return id;
	});
	return { version: NODE_STORE_VERSION, wma, updatedAt: json.updatedAt, nodes, deleted: [...new Set(deleted)] };
}

/** One node's texts checked against the node: one text for each of its files, and nothing else. Throws, naming what is wrong. */
export function parseNodeTexts(json: unknown, node: EwrNode, wma: string): NodeTexts {
	const key = nodeKey(node.id, wma);
	if (key === null) throw new Error(`${node.id} is not an uploaded node of ${wma}.`);
	const where = nodeStorePath.files(wma, key);
	if (!isObject(json)) throw new Error(`${where} is not a JSON object.`);
	const names = new Set(node.files.map((f) => f.name));
	let total = 0;
	const out: NodeTexts = {};
	for (const [name, text] of Object.entries(json)) {
		if (!names.has(name)) throw new Error(`${where}: ${name} is not one of the node's files.`);
		if (typeof text !== 'string') throw new Error(`${where}: ${name} is not text.`);
		if (text.length > NODE_STORE_LIMITS.fileChars) throw new Error(`${where}: ${name} is longer than ${NODE_STORE_LIMITS.fileChars} characters.`);
		total += text.length;
		out[name] = text;
	}
	if (total > NODE_STORE_LIMITS.nodeChars) throw new Error(`${where}: the node's files together are longer than ${NODE_STORE_LIMITS.nodeChars} characters.`);
	for (const name of names) if (!(name in out)) throw new Error(`${where}: ${name} has no text.`);
	return out;
}

function parseNode(json: unknown, wma: string, where: string): EwrNode {
	if (!isObject(json)) throw new Error(`${where} is not an object.`);
	const id = json.id;
	if (typeof id !== 'string' || nodeKey(id, wma) === null) {
		throw new Error(`${where}: id must be ${wma}:<key>, the key lowercase letters, digits, '-' and '_', at most 40.`);
	}
	const at = `${where} (${id})`;
	const text = (k: string, required = false): string => {
		const v = json[k];
		if (v === undefined && !required) return '';
		if (typeof v !== 'string' || v.length > NODE_STORE_LIMITS.textChars || (required && !v.trim())) throw new Error(`${at}: ${k} must be text${required ? '' : ' or left out'}.`);
		return v;
	};
	const coord = (k: string, min: number, max: number): number | null => {
		const v = json[k];
		if (v === null || v === undefined) return null;
		if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${at}: ${k} must be a number from ${min} to ${max}, or null.`);
		return v;
	};
	const lon = coord('lon', -180, 180);
	const lat = coord('lat', -90, 90);
	if ((lon === null) !== (lat === null)) throw new Error(`${at}: lon and lat go together.`);
	const gazPct = json.gazPct;
	if (gazPct !== undefined && gazPct !== null && (typeof gazPct !== 'number' || !Number.isFinite(gazPct) || gazPct < 0)) throw new Error(`${at}: gazPct must be a number or null.`);
	if (json.approx !== undefined && typeof json.approx !== 'boolean') throw new Error(`${at}: approx must be true or false.`);
	const files = parseFiles(json.files, at);
	const sites = parseSites(json.sites, at);
	const ecSource = parseStringRecord(json.ecSource, at, 'ecSource');
	// Worked out from the files as build_data.py does, never taken from the upload, so a node can't
	// claim a method or an EC it has no file for: a .tab or _Con.txt run with an EC on the ladder, and
	// a Revised file's first seven ECs.
	const tabEcs = new Set(files.filter((f) => (f.kind === 'tab' || f.kind === 'con') && LADDER.includes(f.ec)).map((f) => f.ec));
	const revised = files.some((f) => f.kind === 'revised');
	const ecsAvailable = LADDER.filter((ec) => tabEcs.has(ec) || (revised && LADDER.indexOf(ec) < 7));
	return {
		id,
		label: text('label', true),
		basin: text('basin', true),
		quat: text('quat'),
		river: text('river'),
		comment: text('comment'),
		lon,
		lat,
		approx: json.approx === true,
		pes: text('pes'),
		rec: text('rec'),
		tec: text('tec'),
		tecInc: text('tecInc'),
		tecCum: text('tecCum'),
		iua: text('iua'),
		ewrClass: text('ewrClass'),
		ru: text('ru'),
		ewrBasis: text('ewrBasis'),
		ewrNote: text('ewrNote'),
		gazPct: typeof gazPct === 'number' ? gazPct : null,
		sites,
		ecSource,
		files,
		ecsAvailable,
		hasTab: tabEcs.size > 0,
		hasRevised: revised
	};
}

function parseFiles(json: unknown, at: string): NodeFile[] {
	if (!Array.isArray(json)) throw new Error(`${at}: files must be a list.`);
	if (json.length > NODE_STORE_LIMITS.filesPerNode) throw new Error(`${at}: more than ${NODE_STORE_LIMITS.filesPerNode} files.`);
	const seen = new Set<string>();
	return json.map((f, i) => {
		const where = `${at}: file ${i + 1}`;
		if (!isObject(f)) throw new Error(`${where} is not an object.`);
		if (typeof f.name !== 'string' || !FILE_NAME.test(f.name)) throw new Error(`${where}: name must be a file name of at most 120 characters, with no '/' or '\\'.`);
		if (seen.has(f.name)) throw new Error(`${at}: ${f.name} is there twice.`);
		seen.add(f.name);
		if (!FILE_KINDS.includes(f.kind as FileKind)) throw new Error(`${where} (${f.name}): kind must be one of ${FILE_KINDS.join(', ')}.`);
		for (const k of ['ec', 'basis', 'ecNote'] as const) {
			if (f[k] !== undefined && (typeof f[k] !== 'string' || (f[k] as string).length > NODE_STORE_LIMITS.textChars)) throw new Error(`${where} (${f.name}): ${k} must be text.`);
		}
		if (f.variant !== undefined && typeof f.variant !== 'boolean') throw new Error(`${where} (${f.name}): variant must be true or false.`);
		const file: NodeFile = { name: f.name, kind: f.kind as FileKind, ec: (f.ec as string | undefined) ?? '', basis: (f.basis as string | undefined) ?? '' };
		if (f.variant === true) file.variant = true;
		if (typeof f.ecNote === 'string' && f.ecNote) file.ecNote = f.ecNote;
		return file;
	});
}

function parseSites(json: unknown, at: string): EwrNode['sites'] {
	if (json === undefined) return [];
	if (!Array.isArray(json) || json.length > 20) throw new Error(`${at}: sites must be a list of at most 20.`);
	return json.map((s) => {
		if (!isObject(s) || typeof s.label !== 'string' || typeof s.how !== 'string' || s.label.length > NODE_STORE_LIMITS.textChars || s.how.length > NODE_STORE_LIMITS.textChars) {
			throw new Error(`${at}: each site needs a label and how, as text.`);
		}
		return { label: s.label, how: s.how };
	});
}

function parseStringRecord(json: unknown, at: string, what: string): Record<string, string> {
	if (json === undefined) return {};
	if (!isObject(json) || Object.keys(json).length > 20) throw new Error(`${at}: ${what} must be an object of at most 20 texts.`);
	for (const v of Object.values(json)) if (typeof v !== 'string' || v.length > NODE_STORE_LIMITS.textChars) throw new Error(`${at}: ${what} must hold text only.`);
	return { ...(json as Record<string, string>) };
}

