// The node store (#17) read into the app: each WMA's overlay merged over the built-in nodes, an
// uploaded node's texts read against it, and a node an admin adds by hand made with the import's
// own matching. Pure: no DOM, no fetch. The format is nodeStore.ts; docs/architecture.md § Node store.
import type { Placemark } from './kml.ts';
import { nodeKey, parseNodeTexts, type NodeTexts, type WmaOverlay } from './nodeStore.ts';
import { attachFile, attachable, codeKey, matchUpload, type UploadReport } from './uploadMatch.ts';
import type { EwrNode } from './types.ts';

/** The nodes the app shows, with what the store changed. */
export interface Merged {
	/** Built-in nodes in their order, a replaced one in its place, then each WMA's uploaded nodes. */
	nodes: EwrNode[];
	/** The WMA of each node from the store, by id: its overlay's, whatever its basin. */
	uploaded: Map<string, string>;
	/** Built-in nodes a WMA's `deleted` hides, for an admin to restore. */
	hidden: { wma: string; node: EwrNode }[];
}

/**
 * Each WMA's overlay over the built-in nodes. An uploaded node with a built-in node's id takes its
 * place; any other is added. A built-in node is hidden by its own WMA's `deleted` (`wmaOf`, its
 * basin's WMA), never another's. Overlays are applied in the order given.
 */
export function mergeOverlays(builtIn: readonly EwrNode[], overlays: readonly WmaOverlay[], wmaOf: (n: EwrNode) => string | undefined): Merged {
	const uploaded = new Map<string, string>();
	const replace = new Map<string, EwrNode>();
	const added: EwrNode[] = [];
	const builtInIds = new Set(builtIn.map((n) => n.id));
	const deleted = new Map<string, Set<string>>();
	for (const o of overlays) {
		deleted.set(o.wma, new Set(o.deleted));
		for (const n of o.nodes) {
			// Two WMAs can't hold one id (it starts with the WMA), but keep the first should they.
			if (uploaded.has(n.id)) continue;
			uploaded.set(n.id, o.wma);
			if (builtInIds.has(n.id)) replace.set(n.id, n);
			else added.push(n);
		}
	}
	const nodes: EwrNode[] = [];
	const hidden: Merged['hidden'] = [];
	for (const n of builtIn) {
		const over = replace.get(n.id);
		if (over) {
			nodes.push(over);
			continue;
		}
		const wma = wmaOf(n);
		if (wma && deleted.get(wma)?.has(n.id)) hidden.push({ wma, node: n });
		else nodes.push(n);
	}
	return { nodes: [...nodes, ...added], uploaded, hidden };
}

/** An uploaded node's texts, and the files the store has no text for. */
export interface ReadTexts {
	texts: NodeTexts;
	/** Files the node lists whose text is not in its files object: shown as unreadable, never guessed at. */
	missing: string[];
}

/**
 * nodes-data/files/<wma>/<key>.json read for the node as the WMA's file lists it. The API writes a
 * node's texts before its listing, so the two can be a write apart: a text for a file the node no
 * longer lists is left out, and a file with no text is `missing`. What is kept is checked by
 * `parseNodeTexts` as any write is, and throws as it does.
 */
export function readNodeTexts(json: unknown, node: EwrNode, wma: string): ReadTexts {
	if (typeof json !== 'object' || json === null || Array.isArray(json)) return { texts: parseNodeTexts(json, node, wma), missing: [] };
	const listed = new Set(node.files.map((f) => f.name));
	const kept = Object.fromEntries(Object.entries(json).filter(([name]) => listed.has(name)));
	const present = { ...node, files: node.files.filter((f) => Object.hasOwn(kept, f.name)) };
	return { texts: parseNodeTexts(kept, present, wma), missing: node.files.filter((f) => !Object.hasOwn(kept, f.name)).map((f) => f.name) };
}

/** What an admin types for a node added on the map. ECs are '' when not given. */
export interface NewNodeInput {
	wma: string;
	basin: string;
	code: string;
	label: string;
	river: string;
	quat: string;
	pes: string;
	rec: string;
	tec: string;
	lon: number;
	lat: number;
	/** Desktop outputs chosen for it, read as latin-1, as the import reads a folder. */
	files: { name: string; text: string }[];
}

export interface NewNode {
	node: EwrNode;
	texts: NodeTexts;
	report: UploadReport;
	/** Files chosen that could not be the node's, and why. */
	refused: { file: string; detail: string }[];
}

/**
 * A node added by hand, made as the import makes one from a placemark (`matchUpload`), so its id,
 * fields, files and ECs are decided by the same code. A file whose name is the code plus a suffix
 * joins by name; any other Desktop output chosen for it is attached (`attachFile`) and says so.
 * Throws when the code can't be a node key.
 */
export function newNode(input: NewNodeInput): NewNode {
	const code = input.code.trim();
	if (!codeKey(code)) throw new Error(`${code || 'An empty code'} can't be a node code: at most 40 letters, digits, '-' and '_'.`);
	const data: Record<string, string> = { NODE: code };
	for (const [k, v] of [['RIVER', input.river], ['QUAT', input.quat], ['PES', input.pes], ['REC', input.rec], ['TEC', input.tec]] as const) {
		if (v.trim()) data[k] = v.trim();
	}
	const placemark: Placemark = { name: code, lon: input.lon, lat: input.lat, folder: null, data };
	let result = matchUpload({ wma: input.wma, basin: input.basin.trim(), placemarks: [placemark], files: input.files });
	const id = result.nodes[0].id;
	for (const file of attachable(result)) result = attachFile(result, id, file);
	const refused = result.report.unmatched.map((u) => ({ file: u.file, detail: u.detail }));
	const label = input.label.trim() || code;
	return { node: { ...result.nodes[0], label }, texts: result.texts[id] ?? {}, report: result.report, refused };
}

/** The key an added node would be saved under, or null: the import's rule (`codeKey`). */
export const newNodeId = (wma: string, code: string): string | null => {
	const key = codeKey(code.trim());
	return key && nodeKey(`${wma}:${key}`, wma) ? `${wma}:${key}` : null;
};
