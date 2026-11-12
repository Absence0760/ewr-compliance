// The admin node store (#17), as the API writes it: the checks on each request and the writes to
// the bucket (infra/nodes.tf). The format and its limits are src/lib/ewr/nodeStore.ts, imported here
// so the API refuses exactly what the app would refuse to read. app.ts holds the routes, the admin
// check and the audit row; this file decides nothing about who may write.
//
// A write to a WMA is a read-modify-write of wma-<wma>.json and then index.json, each a conditional
// put: If-Match on the ETag read, or If-None-Match: * when there is no file yet. Two admins writing
// the same WMA at once can't lose each other's change: the second put fails its condition, re-reads
// and tries again, up to ATTEMPTS times, then answers 409.
//
// The audit row (the caller's `record`) is written once the change is known to apply to the file
// as read, and before anything is put: a refused change (a node not there, a limit) records nothing,
// a refused audit row writes nothing, and no change is ever unrecorded. A row whose change then
// lost every retry to other admins (a 409) is the one case of a row with no change. Nothing is ever deleted (the role has no
// s3:DeleteObject): a deleted built-in node is a tombstone in `deleted`, and a deleted uploaded
// node's files object is left in place, unreferenced.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
	NODE_STORE_LIMITS,
	NODE_STORE_VERSION,
	WMA_SLUGS,
	nodeKey,
	nodeStoreKey,
	nodeStorePath,
	parseNodeStoreIndex,
	parseNodeTexts,
	parseWmaOverlay,
	type NodeStoreIndex,
	type NodeTexts,
	type WmaOverlay
} from '../../src/lib/ewr/nodeStore.ts';
import type { EwrNode } from '../../src/lib/ewr/types.ts';

/** How each file is written: CloudFront's /nodes-data/* behaviour revalidates by it (infra/site.tf), as the deploy's own data. */
export const NODE_CACHE = 'private, no-cache';
export const NODE_CONTENT_TYPE = 'application/json';

/** Conditional writes tried per file before a 409: each failure means another admin wrote first. */
export const ATTEMPTS = 3;

/**
 * The largest node-store request body read. A function URL takes at most 6 MB, and the format's
 * limits (4 million characters of text a node) keep a node's request under it.
 */
export const MAX_NODE_BODY_BYTES = 6 * 1024 * 1024;

export interface Stored {
	body: string;
	etag: string;
}

/** The bucket, as whole objects under their served path. */
export interface NodeBucket {
	get(path: string): Promise<Stored | null>;
	/** False when the condition failed (someone else wrote first); throws for anything else. */
	put(path: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<boolean>;
}

/** The subset of S3Client this sends through (a stub in the tests). */
export interface S3Like {
	send(command: unknown): Promise<unknown>;
}

const httpStatus = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const named = (err: unknown) => (err as { name?: string })?.name;
const isMissing = (err: unknown) => named(err) === 'NoSuchKey' || named(err) === 'NotFound' || httpStatus(err) === 404;
/** S3's answers to a conditional write that lost: 412, or 409 when two land at once. */
const isConflict = (err: unknown) => named(err) === 'PreconditionFailed' || named(err) === 'ConditionalRequestConflict' || httpStatus(err) === 412 || httpStatus(err) === 409;

/** The bucket in S3. Paths are the served ones (nodes-data/...); the keys are under serve/ (nodeStoreKey). */
export class S3NodeBucket implements NodeBucket {
	readonly #client: S3Like;
	readonly bucket: string;

	constructor(bucket: string, client?: S3Like) {
		this.bucket = bucket;
		this.#client = client ?? new S3Client({});
	}

	async get(path: string): Promise<Stored | null> {
		try {
			const r = (await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: nodeStoreKey(path) }))) as { Body?: { transformToString(): Promise<string> }; ETag?: string };
			return { body: r.Body ? await r.Body.transformToString() : '', etag: r.ETag ?? '' };
		} catch (err) {
			if (isMissing(err)) return null;
			throw err;
		}
	}

	async put(path: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<boolean> {
		try {
			await this.#client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: nodeStoreKey(path),
					Body: body,
					ContentType: NODE_CONTENT_TYPE,
					CacheControl: NODE_CACHE,
					...(cond.ifMatch !== undefined ? { IfMatch: cond.ifMatch } : {}),
					...(cond.ifNoneMatch !== undefined ? { IfNoneMatch: cond.ifNoneMatch } : {})
				})
			);
			return true;
		} catch (err) {
			if ((cond.ifMatch !== undefined || cond.ifNoneMatch !== undefined) && isConflict(err)) return false;
			throw err;
		}
	}
}

/** The bucket in memory, for the tests: every write gets a fresh ETag, and conditions hold as S3's do. */
export class MemoryNodeBucket implements NodeBucket {
	readonly objects = new Map<string, Stored>();
	/** Every write that landed, in order. */
	readonly writes: string[] = [];
	#etag = 0;
	/** Called before each put; a test makes another admin's write land here. */
	beforePut: ((path: string) => Promise<void> | void) | null = null;

	async get(path: string): Promise<Stored | null> {
		const o = this.objects.get(path);
		return o ? { ...o } : null;
	}

	async put(path: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<boolean> {
		await this.beforePut?.(path);
		const now = this.objects.get(path);
		if (cond.ifNoneMatch === '*' && now) return false;
		if (cond.ifMatch !== undefined && now?.etag !== cond.ifMatch) return false;
		this.objects.set(path, { body, etag: `"${++this.#etag}"` });
		this.writes.push(path);
		return true;
	}

	json(path: string): unknown {
		const o = this.objects.get(path);
		return o ? JSON.parse(o.body) : undefined;
	}
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const refuse = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export type Wma = (typeof WMA_SLUGS)[number];

/** What each answer reports: the WMA's counts after the change. */
export interface NodeChange {
	wma: Wma;
	id: string;
	nodes: number;
	deleted: number;
	updatedAt: string;
}

const isWma = (v: unknown): v is Wma => typeof v === 'string' && (WMA_SLUGS as readonly string[]).includes(v);
const BAD_WMA = `Say which WMA: one of ${WMA_SLUGS.join(', ')}.`;

/**
 * A node id to delete or restore: an uploaded node's (`<wma>:<key>`) or a built-in node's, which the
 * API can't check against data/index.json. Kept to text the audit log takes as a target (no `@`, no
 * control character, not padded) and short enough to go in it beside the WMA.
 */
const NODE_ID = /^[^\s@\u0000-\u001f\u007f-\u009f](?:[^@\u0000-\u001f\u007f-\u009f]{0,148}[^\s@\u0000-\u001f\u007f-\u009f])?$/;

/** A request to write one node, checked against the format: the node as a one-node overlay, its texts against its files. */
export function checkPut(body: Record<string, unknown>, at: string): Outcome<{ wma: Wma; node: EwrNode; texts: NodeTexts }> {
	const { wma } = body;
	if (!isWma(wma)) return refuse(400, BAD_WMA);
	try {
		const node = parseWmaOverlay({ version: NODE_STORE_VERSION, wma, updatedAt: at, nodes: [body.node], deleted: [] }, wma, WMA_SLUGS).nodes[0]!;
		return { ok: true, value: { wma, node, texts: parseNodeTexts(body.texts, node, wma) } };
	} catch (e) {
		// The format's own message: it names the field, and quotes nothing but what this admin sent.
		return refuse(400, (e as Error).message);
	}
}

/** A request to delete or restore one node: `{ wma, id }`. */
export function checkTarget(body: Record<string, unknown>): Outcome<{ wma: Wma; id: string }> {
	const { wma, id } = body;
	if (!isWma(wma)) return refuse(400, BAD_WMA);
	if (typeof id !== 'string' || !NODE_ID.test(id)) return refuse(400, 'Give the node id, as text of at most 150 characters.');
	if (WMA_SLUGS.some((w) => w !== wma && nodeKey(id, w) !== null)) return refuse(400, `That node is in another WMA, not ${wma}.`);
	return { ok: true, value: { wma, id } };
}

/** The audit row's target for a change: the WMA and the node id. */
export const auditTarget = (wma: string, id: string) => `${wma} ${id}`;

const emptyOverlay = (wma: Wma): WmaOverlay => ({ version: NODE_STORE_VERSION, wma, updatedAt: '', nodes: [], deleted: [] });
const CONTENDED = 'Another admin changed this WMA at the same time. Reload and try again.';

/** A change to a WMA's file: the next file, or a refusal. Given a copy, free to change it. */
type Change = (o: WmaOverlay) => Outcome<WmaOverlay>;

/** Writes the change's audit row; a refusal stops the change before anything is written. */
export type RecordChange = () => Promise<Outcome<unknown>>;

export function createNodeStore(bucket: NodeBucket, now: () => number) {
	/** Read, change, and put on the condition that nothing changed since the read; again on a conflict. */
	async function changeWma(wma: Wma, id: string, change: Change, record: RecordChange): Promise<Outcome<NodeChange>> {
		const path = nodeStorePath.wma(wma);
		let recorded = false;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const got = await bucket.get(path);
			// A file that fails the format is never built on: it throws, a 500, for the operator to restore a version.
			const current = got ? parseWmaOverlay(JSON.parse(got.body), wma, WMA_SLUGS) : emptyOverlay(wma);
			const next = change(structuredClone(current));
			if (!next.ok) return next;
			const written: WmaOverlay = { ...next.value, updatedAt: new Date(now()).toISOString() };
			// Checked as the app will read it, limits included, before it is written.
			parseWmaOverlay(written, wma, WMA_SLUGS);
			if (!recorded) {
				const r = await record();
				if (!r.ok) return r;
				recorded = true;
			}
			if (await bucket.put(path, JSON.stringify(written), got ? { ifMatch: got.etag } : { ifNoneMatch: '*' })) {
				if (!(await updateIndex(wma, written))) {
					return refuse(409, `The change to ${wma} was saved, but the list of WMAs could not be updated for another admin's change. Send it again.`);
				}
				return { ok: true, value: { wma, id, nodes: written.nodes.length, deleted: written.deleted.length, updatedAt: written.updatedAt } };
			}
		}
		return refuse(409, CONTENDED);
	}

	/** The WMA's entry in index.json, from the file just written; the same conditional loop. */
	async function updateIndex(wma: Wma, o: WmaOverlay): Promise<boolean> {
		const path = nodeStorePath.index;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const got = await bucket.get(path);
			const index: NodeStoreIndex = got ? parseNodeStoreIndex(JSON.parse(got.body), WMA_SLUGS) : { version: NODE_STORE_VERSION, wmas: {} };
			index.wmas[wma] = { updatedAt: o.updatedAt, nodes: o.nodes.length, deleted: o.deleted.length };
			if (await bucket.put(path, JSON.stringify(index), got ? { ifMatch: got.etag } : { ifNoneMatch: '*' })) return true;
		}
		return false;
	}

	return {
		/**
		 * Writes one uploaded node: its texts to files/<wma>/<key>.json (after the audit row), then the
		 * node into the WMA's file, replacing one with its id, and taking its id off `deleted`. The texts go first, so a
		 * node is never listed before its files are there; a replaced node's new texts are served
		 * before its new listing (a moment, or until the admin sends it again after a 409).
		 */
		async putNode(wma: Wma, node: EwrNode, texts: NodeTexts, record: RecordChange): Promise<Outcome<NodeChange>> {
			const withTexts: RecordChange = async () => {
				const r = await record();
				if (r.ok) await bucket.put(nodeStorePath.files(wma, nodeKey(node.id, wma)!), JSON.stringify(texts), {});
				return r;
			};
			return changeWma(
				wma,
				node.id,
				(o) => {
				const at = o.nodes.findIndex((n) => n.id === node.id);
				if (at < 0 && o.nodes.length >= NODE_STORE_LIMITS.nodesPerWma) return refuse(409, `${wma} already holds ${NODE_STORE_LIMITS.nodesPerWma} nodes, the most it can. Delete one first.`);
				if (at < 0) o.nodes.push(node);
				else o.nodes[at] = node;
				o.deleted = o.deleted.filter((d) => d !== node.id);
				return { ok: true, value: o };
				},
				withTexts
			);
		},

		/** Deletes a node: an uploaded one comes out of the WMA's file; any other id is a built-in node, hidden in `deleted`. */
		async deleteNode(wma: Wma, id: string, record: RecordChange): Promise<Outcome<NodeChange & { tombstone: boolean }>> {
			let tombstone = false;
			const r = await changeWma(
				wma,
				id,
				(o) => {
				const at = o.nodes.findIndex((n) => n.id === id);
				if (at >= 0) {
					o.nodes.splice(at, 1);
					return { ok: true, value: o };
				}
				// Shaped as this WMA's upload but not in its file: nothing to delete (built-in ids never take this shape).
				if (nodeKey(id, wma) !== null) return refuse(404, `No uploaded node in ${wma} has that id.`);
				tombstone = true;
				if (!o.deleted.includes(id)) {
					if (o.deleted.length >= NODE_STORE_LIMITS.deletedPerWma) return refuse(409, `${wma} already hides ${NODE_STORE_LIMITS.deletedPerWma} nodes, the most it can.`);
					o.deleted.push(id);
				}
				return { ok: true, value: o };
				},
				record
			);
			return r.ok ? { ok: true, value: { ...r.value, tombstone } } : r;
		},

		/** Restores a deleted built-in node: its id comes off `deleted`. */
		async restoreNode(wma: Wma, id: string, record: RecordChange): Promise<Outcome<NodeChange>> {
			return changeWma(
				wma,
				id,
				(o) => {
					if (!o.deleted.includes(id)) return refuse(404, `No deleted node in ${wma} has that id.`);
					o.deleted = o.deleted.filter((d) => d !== id);
					return { ok: true, value: o };
				},
				record
			);
		}
	};
}

export type NodeStore = ReturnType<typeof createNodeStore>;
