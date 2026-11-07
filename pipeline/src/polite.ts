// The pipeline's one HTTP client, polite by construction: project-water-management's ingest/polite.py
// and feeds/http.ts, ported to TypeScript for DWS.
//
// - One User-Agent naming the project, with the operator's contact address when set (DWS_CONTACT), so
//   DWS can write before blocking us.
// - Pacing: at most one request every `intervalMs` (1 s), retries included, one at a time.
// - Conditional GETs: If-None-Match and If-Modified-Since when the caller has a validator; a 304 is
//   "unchanged" and costs DWS nothing to send.
// - 429 and 503 honour Retry-After (seconds or an HTTP date), up to `maxRetries` times, never waiting
//   past `maxWaitMs` or what `mayWait` allows (the Lambda's time left). Past that: DwsThrottledError,
//   which stops the run.
// - **A 403 throws DwsRefusedError at once and is never retried.** DWS answers 403 to networks outside
//   South Africa, and a refusal is exactly when to stop asking, not ask again.
// - A body is read whole and checked against Content-Length: one cut short is a failed request, never
//   a page. Bodies over MAX_BYTES, other statuses, network errors and timeouts are DwsUnavailableError:
//   that one station is skipped and tried again next run.
// - Redirects are followed by hand, to https on the same host only, at most MAX_REDIRECTS times.
//
// The clock, the sleep and fetch are injected, so the tests never touch the network or wait.
import { DwsRefusedError, DwsThrottledError, DwsUnavailableError } from './errors.ts';

export const USER_AGENT = 'ewr-compliance-pipeline/1 (+https://github.com/Absence0760/ewr-compliance)';
export const REQUEST_INTERVAL_MS = 1000;
/** A two-year daily page is ~20 kB and twenty years ~200 kB: anything near this is not the table. */
export const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONTACT = /^[^@\s<>()]+@[^@\s<>()]+\.[^@\s<>().]+$/;

/** The user agent, with the contact when it looks like an address (anything else is left out, never sent half-formed). */
export function userAgent(contact: string | undefined): string {
	const c = contact?.trim();
	return c && CONTACT.test(c) ? `${USER_AGENT.slice(0, -1)}; ${c})` : USER_AGENT;
}

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date; null if absent or unreadable. */
export function retryAfterMs(value: string | null, now: number): number | null {
	if (value === null) return null;
	const v = value.trim();
	if (/^\d+$/.test(v)) return Number(v) * 1000;
	const at = Date.parse(v);
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface Validators {
	etag?: string | null;
	lastModified?: string | null;
}

export type Fetched = { status: 200; body: string; etag: string | null; lastModified: string | null } | { status: 304 } | { status: 404 };

export interface PoliteOptions {
	contact?: string;
	intervalMs?: number;
	maxRetries?: number;
	maxWaitMs?: number;
	/** Without a Retry-After, the first wait; it doubles on each retry. */
	defaultBackoffMs?: number;
	timeoutMs?: number;
	/** Whether there is time left to wait this long and ask again (the Lambda's budget). */
	mayWait?: (ms: number) => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	fetch?: typeof fetch;
}

export class PoliteClient {
	readonly userAgent: string;
	requests = 0;
	#last = -Infinity;
	readonly #o: Required<Omit<PoliteOptions, 'contact'>>;

	constructor(o: PoliteOptions = {}) {
		this.userAgent = userAgent(o.contact);
		this.#o = {
			intervalMs: o.intervalMs ?? REQUEST_INTERVAL_MS,
			maxRetries: o.maxRetries ?? 2,
			maxWaitMs: o.maxWaitMs ?? 120_000,
			defaultBackoffMs: o.defaultBackoffMs ?? 30_000,
			timeoutMs: o.timeoutMs ?? 60_000,
			mayWait: o.mayWait ?? (() => true),
			now: o.now ?? Date.now,
			sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
			fetch: o.fetch ?? fetch
		};
	}

	/** Every request, retries and redirects included, waits for the one before by intervalMs. */
	async #pace(): Promise<void> {
		const left = this.#last + this.#o.intervalMs - this.#o.now();
		if (left > 0) await this.#o.sleep(left);
		this.#last = this.#o.now();
		this.requests++;
	}

	async get(url: string, v: Validators = {}): Promise<Fetched> {
		const headers: Record<string, string> = { 'User-Agent': this.userAgent, Accept: 'text/html, text/plain' };
		if (v.etag) headers['If-None-Match'] = v.etag;
		if (v.lastModified) headers['If-Modified-Since'] = v.lastModified;
		let attempt = 0;
		let target = new URL(url);
		let hops = 0;
		for (;;) {
			await this.#pace();
			let res: Response;
			try {
				res = await this.#o.fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.#o.timeoutMs) });
			} catch {
				throw new DwsUnavailableError('no answer');
			}
			const s = res.status;
			if (s === 403) {
				await res.body?.cancel();
				throw new DwsRefusedError();
			}
			if (s === 304) {
				await res.body?.cancel();
				return { status: 304 };
			}
			if (s === 404) {
				await res.body?.cancel();
				return { status: 404 };
			}
			if (s >= 300 && s <= 399) {
				await res.body?.cancel();
				const next = res.headers.get('location');
				const to = next ? new URL(next, target) : null;
				if (!to || to.protocol !== 'https:' || to.host !== target.host || ++hops > MAX_REDIRECTS) throw new DwsUnavailableError('redirected away');
				target = to;
				continue;
			}
			if (s === 429 || s === 503) {
				await res.body?.cancel();
				attempt++;
				const asked = retryAfterMs(res.headers.get('retry-after'), this.#o.now());
				const wait = asked ?? this.#o.defaultBackoffMs * 2 ** (attempt - 1);
				const seconds = asked === null ? null : Math.ceil(asked / 1000);
				if (attempt > this.#o.maxRetries || wait > this.#o.maxWaitMs || !this.#o.mayWait(wait)) throw new DwsThrottledError(s, seconds);
				await this.#o.sleep(wait);
				continue;
			}
			if (s !== 200) {
				await res.body?.cancel();
				throw new DwsUnavailableError(`HTTP ${s}`);
			}
			const body = await readBody(res);
			return { status: 200, body, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
		}
	}
}

/** The body, whole: refused over MAX_BYTES, and when it ends before its Content-Length. */
async function readBody(res: Response): Promise<string> {
	const encoded = (res.headers.get('content-encoding') ?? '').trim().toLowerCase();
	const declared = Number(res.headers.get('content-length') ?? NaN);
	if (Number.isFinite(declared) && declared > MAX_BYTES) {
		await res.body?.cancel();
		throw new DwsUnavailableError('page too large');
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		const reader = res.body?.getReader();
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_BYTES) {
					await reader.cancel();
					throw new DwsUnavailableError('page too large');
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		if (err instanceof DwsUnavailableError) throw err;
		throw new DwsUnavailableError('page cut short');
	}
	// fetch decodes a compressed body, so its length is only checkable when the body came as sent.
	if ((encoded === '' || encoded === 'identity') && Number.isFinite(declared) && total !== declared) throw new DwsUnavailableError('page cut short');
	return Buffer.concat(chunks).toString('utf8');
}
