// The DWS store's bucket (infra/dws.tf), as the pipeline sees it: whole objects by key, with S3's
// conditional writes for the lease. S3Store is the bucket; MemoryStore stands in for it in the tests
// with the same conditional semantics (an ETag that changes on every write).
//
// Keys, and who writes them:
//   config/stations.json                 the station list, by tools/dws-stations.sh only (read here)
//   raw/<station>/daily/<from>_<to>.txt  each page as DWS sent it, kept for the record
//   serve/dws/index.json                 what CloudFront serves as dws/index.json
//   serve/dws/flows-<station>.json       what it serves as dws/flows-<station>.json
// CloudFront's /dws/* behaviour reads this bucket with origin_path /serve, and an origin path is put
// in front of the whole request path: /dws/index.json is the key serve/dws/index.json. Only serve/
// is readable by CloudFront (infra/dws.tf's bucket policy).
//   state/status.json                    per station, its last good fetch and what its file covers
//   lease/dws.json                       the one run allowed to ask DWS (lease.ts), never deleted
import { randomUUID } from 'node:crypto';

export interface Stored {
	body: string;
	etag: string;
}

export interface PutOptions {
	contentType: string;
	cacheControl?: string;
	/** Only if nothing is there yet. */
	ifNoneMatch?: '*';
	/** Only if what is there still has this ETag. */
	ifMatch?: string;
}

export interface Store {
	get(key: string): Promise<Stored | null>;
	exists(key: string): Promise<boolean>;
	/** False when a condition failed (someone else wrote first); throws for anything else. Nothing is ever deleted. */
	put(key: string, body: string, o: PutOptions): Promise<boolean>;
}

export const KEYS = {
	stations: 'config/stations.json',
	status: 'state/status.json',
	lease: 'lease/dws.json',
	index: 'serve/dws/index.json',
	flows: (station: string) => `serve/dws/flows-${station}.json`,
	raw: (station: string, from: string, to: string) => `raw/${station}/daily/${from}_${to}.txt`
} as const;

/** What the site serves: revalidated on every read, as the deploy's own data is (tools/deploy.sh). */
export const SERVE_CACHE = 'private, no-cache';

/** The subset of S3Client this sends through (a stub in the tests). */
export interface S3Like {
	send(command: unknown): Promise<unknown>;
}

const status = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const named = (err: unknown) => (err as { name?: string })?.name;
const isMissing = (err: unknown) => named(err) === 'NoSuchKey' || named(err) === 'NotFound' || status(err) === 404;
/** S3's answers to a conditional write that lost: 412, or 409 when two land at once. */
const isConflict = (err: unknown) => named(err) === 'PreconditionFailed' || named(err) === 'ConditionalRequestConflict' || status(err) === 412 || status(err) === 409;

export class S3Store implements Store {
	readonly #sdk = import('@aws-sdk/client-s3');
	readonly #client: Promise<S3Like>;

	constructor(
		readonly bucket: string,
		client?: S3Like
	) {
		this.#client = client ? Promise.resolve(client) : this.#sdk.then((s) => new s.S3Client({}));
	}

	async get(Key: string): Promise<Stored | null> {
		const [s3, sdk] = await Promise.all([this.#client, this.#sdk]);
		try {
			const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key }))) as { Body?: { transformToString(): Promise<string> }; ETag?: string };
			return { body: r.Body ? await r.Body.transformToString() : '', etag: r.ETag ?? '' };
		} catch (err) {
			if (isMissing(err)) return null;
			throw err;
		}
	}

	async exists(Key: string): Promise<boolean> {
		const [s3, sdk] = await Promise.all([this.#client, this.#sdk]);
		try {
			await s3.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key }));
			return true;
		} catch (err) {
			if (isMissing(err)) return false;
			throw err;
		}
	}

	async put(Key: string, Body: string, o: PutOptions): Promise<boolean> {
		const [s3, sdk] = await Promise.all([this.#client, this.#sdk]);
		try {
			await s3.send(
				new sdk.PutObjectCommand({
					Bucket: this.bucket,
					Key,
					Body,
					ContentType: o.contentType,
					...(o.cacheControl ? { CacheControl: o.cacheControl } : {}),
					...(o.ifNoneMatch ? { IfNoneMatch: o.ifNoneMatch } : {}),
					...(o.ifMatch ? { IfMatch: o.ifMatch } : {})
				})
			);
			return true;
		} catch (err) {
			if ((o.ifNoneMatch || o.ifMatch) && isConflict(err)) return false;
			throw err;
		}
	}

}

/** The bucket in memory, for the tests: every write gets a fresh ETag, and conditions hold as S3's do. */
export class MemoryStore implements Store {
	readonly objects = new Map<string, Stored & { contentType: string; cacheControl?: string }>();
	/** Every write, in order, for the tests to check what was written when. */
	readonly writes: string[] = [];
	/** Throws for a put of a key matching this, to stand in for a bucket that refuses a write. */
	failPut: RegExp | null = null;

	async get(key: string): Promise<Stored | null> {
		const o = this.objects.get(key);
		return o ? { body: o.body, etag: o.etag } : null;
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key);
	}

	async put(key: string, body: string, o: PutOptions): Promise<boolean> {
		if (this.failPut?.test(key)) throw new Error(`MemoryStore refused ${key}`);
		const now = this.objects.get(key);
		if (o.ifNoneMatch && now) return false;
		if (o.ifMatch && now?.etag !== o.ifMatch) return false;
		this.objects.set(key, { body, etag: `"${randomUUID()}"`, contentType: o.contentType, ...(o.cacheControl ? { cacheControl: o.cacheControl } : {}) });
		this.writes.push(key);
		return true;
	}


	/** The JSON at a key, for the tests. */
	json(key: string): unknown {
		const o = this.objects.get(key);
		return o ? JSON.parse(o.body) : undefined;
	}
}
