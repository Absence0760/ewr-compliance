// The pipeline's two runs, after project-water-management's weekly DWS pass (backend/src/ingest/dws.ts):
//
//   daily     the EventBridge rule's run (infra/dws.tf). Reads the station list and the status, and
//             pulls each station whose last current pull is REFRESH_HOURS old or more: never tried
//             first, then by its last turn, good or failed, oldest first, so a station that keeps
//             failing goes behind the rest rather than ahead of them every run. Each asks for the
//             newest DWS_WINDOW_DAYS, today included. It stops at the deadline (the Lambda's time
//             left); the rest go first next run. It publishes the lag metric the freshness alarm reads.
//   backfill  one window of the Step Functions backfill (infra/dws_backfill.tf), for every listed
//             station. A station whose raw page for that window is already stored is done and skipped,
//             so a failed or stopped execution resumes by being started again with the same plan.
//
// One station's pull: GET the page (polite.ts), read it (hydata.ts readPage), merge its days into the
// station's stored daily file, later fetch winning day by day (a day the new page doesn't list keeps
// what an earlier fetch stored: nothing is ever dropped because a page came back shorter), render it
// in EWR's .day layout (renderDay, checked by EWR's parseDay), and write, in this order:
//   1. serve/dws/flows-<station>.json, once checked by EWR's parseGaugeFlows;
//   2. raw/<station>/daily/<from>_<to>.txt, the page as sent (its being there means 1 is done);
//   3. state/status.json, then serve/dws/index.json, checked by the app's own parseDwsIndex.
// A station is listed in the index only once its flows file holds at least one day.
//
// Politeness: at most one request a second, one run at a time (the lease), and an HTTP 403, throttling
// past what Retry-After allows, the ScriptServer page, or MAX_UNAVAILABLE_IN_A_ROW stations DWS didn't
// answer stops the run at once, never retried: the status says why, the lag keeps growing, and the
// invocation fails (the stopped alarm, and the DLQ for a daily run). The next runs, daily or backfill,
// then ask DWS nothing until the stop cools down (coolingUntil: an hour after throttling, the ScriptServer
// page or DWS not answering), unless the operator's event says ignoreStop. A refusal (403) never cools
// down on its own: every run waits until the operator, having understood it, runs one with ignoreStop. A station whose own page fails
// another way (a changed layout, a value out of bounds, not found, a timeout) is skipped, logged by
// station and fixed label, and tried again next run.
//
// The status is written however the run ends, so what it fetched before a failure is never lost. No
// request outlives the deadline (polite.ts), so the save margin is always there.
import { parseDwsIndex, type DwsIndex } from '../../src/lib/ewr/dwsStore.ts';
import { parseGaugeFlows } from '../../src/lib/ewr/parsers.ts';
import {
	CoolingDownError,
	DwsDownError,
	DwsFormatError,
	DwsUnavailableError,
	failureLabel,
	isStop,
	LeaseBusyError,
	StationsFailedError,
	StoreFormatError,
	stopReason,
	WindowUnfinishedError,
	type DwsStop,
	type StopReason
} from './errors.ts';
import { DWS_MAX_WINDOW_DAYS, DWS_WINDOW_DAYS, dwsUrl, lineRow, readPage, renderDay, STATION, type DayRow } from './hydata.ts';
import { takeLease } from './lease.ts';
import { PoliteClient } from './polite.ts';
import { KEYS, SERVE_CACHE, type Store } from './store.ts';

/** A station is pulled again once its last current pull is this old: a daily schedule, with slack for the rule's jitter. */
export const REFRESH_HOURS = 20;
/** A station whose last current pull is older than this is marked stale in the index: two missed daily runs and a day's slack. */
export const STALE_AFTER_DAYS = 3;
/** The most stations the list may hold. */
export const MAX_STATIONS = 500;
/** After a run stopped by throttling, the ScriptServer page or DWS not answering, no run asks again for this long. */
export const STOP_COOLDOWN_HOURS = 1;
/** DWS failing to answer this many stations running (network, timeouts, 5xx) means it is down: the run stops asking. */
export const MAX_UNAVAILABLE_IN_A_ROW = 5;

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day in South Africa (UTC+2, no daylight saving), where DWS dates its rows. */
export const sastDay = (ms: number) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const toIso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// --- The station list (config/stations.json, written by tools/dws-stations.sh) ---------------------

export interface StationsFile {
	v: 1;
	/** When the list was last written. */
	at: string;
	stations: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T.*(Z|[+-]\d{2}:\d{2})$/.test(v);

export function parseStations(text: string): StationsFile {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw new StoreFormatError('config/stations.json is not JSON');
	}
	if (!isObject(v) || v.v !== 1 || !isTime(v.at) || !Array.isArray(v.stations)) throw new StoreFormatError('config/stations.json is not a v1 station list');
	const stations = v.stations;
	if (stations.length > MAX_STATIONS) throw new StoreFormatError('config/stations.json lists too many stations');
	if (!stations.every((s): s is string => typeof s === 'string' && STATION.test(s))) throw new StoreFormatError('config/stations.json lists something that is not a DWS river gauge');
	if (new Set(stations).size !== stations.length) throw new StoreFormatError('config/stations.json lists a station twice');
	return { v: 1, at: v.at, stations: [...stations].sort() };
}

// --- The status (state/status.json) -----------------------------------------------------------------

export interface StationStatus {
	/** When the last good pull of this station ended, of any window: the index's fetchedAt. */
	okAt: string | null;
	/** When the last good pull of a window reaching today ended: what keeps it current. */
	currentAt: string | null;
	/** When it was last tried, good or not. */
	triedAt: string;
	/** The days its flows file holds; null until it holds one. */
	covers: { from: string; to: string } | null;
	/** The last daily window's validators, for a conditional GET of the same window. */
	validators: { window: string; etag: string | null; lastModified: string | null } | null;
}

export interface StatusFile {
	v: 1;
	runAt: string;
	mode: 'daily' | 'backfill';
	/** How the last run that asked DWS was stopped by it, if it was; the next runs cool down (coolingUntil). */
	stopped: StopReason | null;
	stations: Record<string, StationStatus>;
}

const isTimeOrNull = (v: unknown) => v === null || isTime(v);

function checkStation(e: unknown): e is StationStatus {
	if (!isObject(e) || !isTimeOrNull(e.okAt) || !isTimeOrNull(e.currentAt) || !isTime(e.triedAt)) return false;
	const c = e.covers;
	if (c !== null && !(isObject(c) && typeof c.from === 'string' && typeof c.to === 'string' && ISO_DAY.test(c.from) && ISO_DAY.test(c.to))) return false;
	const val = e.validators;
	return val === null || (isObject(val) && typeof val.window === 'string');
}

export function parseStatus(text: string): StatusFile {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw new StoreFormatError('state/status.json is not JSON');
	}
	if (!isObject(v) || v.v !== 1 || !isObject(v.stations)) throw new StoreFormatError('state/status.json is not a v1 status');
	for (const [s, e] of Object.entries(v.stations)) {
		if (!STATION.test(s) || !checkStation(e)) throw new StoreFormatError('state/status.json has an entry that is not a station status');
	}
	return v as unknown as StatusFile;
}

// --- The index (serve/dws/index.json) ------------------------------------------------------------------

/** Whether a station's pulls have stopped keeping it current. Worked out here, where the schedule is known: the app never guesses it. */
export const isStale = (e: StationStatus, now: number) => e.currentAt === null || now - Date.parse(e.currentAt) > STALE_AFTER_DAYS * DAY_MS;

/** dws/index.json, from the status, for the listed stations whose flows file holds a day. Checked by the app's own reader. */
export function buildIndex(listed: string[], stations: Record<string, StationStatus>, now: number): DwsIndex {
	const out: Record<string, { fetchedAt: string; covers: { from: string; to: string }; stale: boolean; monthly: boolean }> = {};
	for (const s of listed) {
		const e = stations[s];
		if (!e?.covers || !e.okAt) continue;
		out[s] = { fetchedAt: e.okAt, covers: e.covers, stale: isStale(e, now), monthly: false };
	}
	const index = { version: 1, stations: out };
	try {
		parseDwsIndex(index);
	} catch {
		// Its message names the station: this one doesn't.
		throw new StoreFormatError("the index failed the app's own reader");
	}
	return index;
}

// --- The flows file (serve/dws/flows-<station>.json) ---------------------------------------------------

interface FlowsFile {
	daily: string;
	readings: string;
}

/** The stored file's days by date, as its rows were written, and its readings kept as they are. */
function readFlows(text: string): { days: Map<string, DayRow>; readings: string } {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw new StoreFormatError('a stored flows file is not JSON');
	}
	if (!isObject(v) || typeof v.daily !== 'string' || typeof v.readings !== 'string') throw new StoreFormatError('a stored flows file is not { daily, readings }');
	const days = new Map<string, DayRow>();
	for (const line of v.daily.split(/\r?\n/)) {
		const r = lineRow(line);
		if (r) days.set(r.day, r);
	}
	return { days, readings: v.readings };
}

/** Later fetch wins, day by day: each day the page lists replaces the stored one; every other stored day stays. */
export function mergeDays(stored: Map<string, DayRow>, page: DayRow[]): DayRow[] {
	const days = new Map(stored);
	for (const r of page) days.set(r.day, r);
	return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// --- A run ------------------------------------------------------------------------------------------

export type Log = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) => void;

export interface RunContext {
	store: Store;
	client: PoliteClient;
	now: () => number;
	/** Epoch ms after which no new station is started (the Lambda's time left, less the time to save). */
	deadline: number;
	/** The Lambda's time left, for the lease's expiry. */
	remainingMs: number;
	log: Log;
	/** Publishes the daily run's lag (emitLag in the Lambda; a recorder in the tests). */
	emitLag: (lagDays: number | null) => void;
	/** Ask DWS even though the last run's stop is still cooling down: the operator's override, from the event. */
	ignoreStop?: boolean;
}

export interface RunResult {
	mode: 'daily' | 'backfill';
	/** Stations pulled and written (or unchanged by a 304). */
	pulled: string[];
	/** Stations whose page failed another way: skipped, tried again. */
	failed: string[];
	/** Listed stations recent enough to wait (daily), or already stored for this window (backfill). */
	skipped: number;
	stopped: 'no_stations' | 'busy' | 'cooling' | 'done' | 'deadline' | StopReason;
	requests: number;
	/** Days since the oldest listed station's last current pull (one never pulled counts from the list's date); null without a list. */
	lagDays: number | null;
}

async function readJsonKey<T>(store: Store, key: string, parse: (text: string) => T): Promise<T | null> {
	const got = await store.get(key);
	return got === null ? null : parse(got.body);
}

const json = (v: unknown) => `${JSON.stringify(v)}\n`;

/** The pass's state while it runs: the status it started from, kept up as each station is done, and saved on every exit. */
class Pass {
	readonly stations: Record<string, StationStatus> = {};

	constructor(
		readonly ctx: RunContext,
		readonly mode: 'daily' | 'backfill',
		readonly list: StationsFile,
		previous: StatusFile | null
	) {
		// Only listed stations are kept: one dropped from the list drops out of the status and the index.
		for (const s of list.stations) if (previous?.stations[s]) this.stations[s] = previous.stations[s]!;
	}

	/** state/status.json, then serve/dws/index.json, in that order: the index never lists more than the status records. */
	async save(stopped: StatusFile['stopped']): Promise<void> {
		const now = this.ctx.now();
		const status: StatusFile = { v: 1, runAt: new Date(now).toISOString(), mode: this.mode, stopped, stations: this.stations };
		await this.ctx.store.put(KEYS.status, json(status), { contentType: 'application/json' });
		const index = buildIndex(this.list.stations, this.stations, now);
		await this.ctx.store.put(KEYS.index, json(index), { contentType: 'application/json', cacheControl: SERVE_CACHE });
	}

	lagDays(): number {
		const today = sastDay(this.ctx.now());
		return Math.max(0, ...this.list.stations.map((s) => daysBetween(sastDay(Date.parse(this.stations[s]?.currentAt ?? this.list.at)), today)));
	}

	/**
	 * One station's window: fetched, read, merged and written (the header's order). Throws DWS's stops and
	 * this station's failures; the caller decides which end the run.
	 */
	async pull(station: string, from: string, to: string): Promise<void> {
		const { store, client, now } = this.ctx;
		const window = `${from}_${to}`;
		const triedAt = new Date(now()).toISOString();
		const before = this.stations[station];
		this.stations[station] = before ? { ...before, triedAt } : { okAt: null, currentAt: null, covers: null, validators: null, triedAt };
		const reachesToday = to >= addDays(sastDay(now()), -1);
		const v = this.mode === 'daily' && before?.validators?.window === window ? before.validators : {};
		const got = await client.get(dwsUrl(station, from, to), v);
		if (got.status === 404) throw new DwsFormatError('page not found');
		const doneAt = () => new Date(now()).toISOString();
		if (got.status === 304) {
			// Unchanged since the same window's last pull, whose days are already merged.
			const t = doneAt();
			this.stations[station] = { ...this.stations[station]!, okAt: t, ...(reachesToday ? { currentAt: t } : {}) };
			return;
		}
		const page = readPage(got.body, { from, to });
		const prev = await store.get(KEYS.flows(station));
		const stored = prev ? readFlows(prev.body) : { days: new Map<string, DayRow>(), readings: '' };
		const rows = mergeDays(stored.days, page.rows);
		// No days stored or listed yet: no flows file, so nothing for the index to list.
		let covers: StationStatus['covers'] = null;
		if (rows.length) {
			const file: FlowsFile = { daily: renderDay(station, rows), readings: stored.readings };
			const parsed = parseGaugeFlows(file);
			if (parsed.daily.length !== rows.length) throw new StoreFormatError('the merged daily file does not read back whole');
			const body = json(file);
			if (prev?.body !== body) await store.put(KEYS.flows(station), body, { contentType: 'application/json', cacheControl: SERVE_CACHE });
			covers = { from: toIso(rows[0]!.day), to: toIso(rows.at(-1)!.day) };
		}
		await store.put(KEYS.raw(station, from, to), got.body, { contentType: 'text/plain; charset=utf-8' });
		const t = doneAt();
		this.stations[station] = {
			okAt: t,
			currentAt: reachesToday ? t : (before?.currentAt ?? null),
			triedAt,
			covers,
			validators: this.mode === 'daily' && (got.etag || got.lastModified) ? { window, etag: got.etag, lastModified: got.lastModified } : (before?.validators ?? null)
		};
		// Counts only, no station: an info line that fires on ordinary pages (a failure names its station, at warn).
		if (page.outside || page.blanked) this.ctx.log('info', { event: 'dws_page_adjusted', outside: page.outside, blanked: page.blanked });
	}
}

/** The status and index, saved however the run ends. When something already threw, that is the failure reported, not a save's. */
async function saveOnExit(pass: Pass, stop: DwsStop | null, threw: boolean): Promise<void> {
	try {
		await pass.save(stop ? stopReason(stop) : null);
	} catch (err) {
		if (!threw) throw err;
	}
}

const isStationFailure = (err: unknown) => err instanceof DwsFormatError || err instanceof DwsUnavailableError || err instanceof StoreFormatError;
const isOutOfTime = (err: unknown) => err instanceof DwsUnavailableError && err.label === PoliteClient.OUT_OF_TIME;

/**
 * When the last run's stop still holds: an hour for anything but a refusal. A refusal holds until a run
 * with ignoreStop gets past it (Infinity): with a daily schedule, any timed cool-down shorter than a day
 * would let the next scheduled run ask again, and DWS refusing us is for the operator to understand
 * before anything asks it again. Null when no stop holds.
 */
export function coolingUntil(previous: StatusFile | null): number | null {
	if (!previous?.stopped || !isTime(previous.runAt)) return null;
	if (previous.stopped === 'refused') return Infinity;
	return Date.parse(previous.runAt) + STOP_COOLDOWN_HOURS * 3600_000;
}

/** What a cool-down's end is called in a log line or an error. */
export const coolingLabel = (until: number) => (until === Infinity ? 'a run with ignoreStop' : new Date(until).toISOString());

interface Loop {
	pulled: string[];
	failed: string[];
	skipped: number;
	stopped: RunResult['stopped'];
	stop: DwsStop | null;
	/** Stations not reached by the deadline. */
	left: number;
}

/**
 * Pulls each station's window in turn, saving after each, and the status however it ends. Stops at a DWS
 * stop, at MAX_UNAVAILABLE_IN_A_ROW stations DWS didn't answer, or at the deadline (also when a request is
 * cut short by it). With `skipStored`, a station whose raw page for the window is stored is done.
 */
async function pullEach(ctx: RunContext, pass: Pass, stations: string[], window: { from: string; to: string }, skipStored: boolean): Promise<Loop> {
	const { from, to } = window;
	const out: Loop = { pulled: [], failed: [], skipped: 0, stopped: 'done', stop: null, left: 0 };
	let unanswered = 0;
	let threw = false;
	try {
		for (const [i, station] of stations.entries()) {
			if (skipStored && (await ctx.store.exists(KEYS.raw(station, from, to)))) {
				out.skipped++;
				continue;
			}
			if (ctx.now() >= ctx.deadline) {
				out.left = stations.length - i;
				out.stopped = 'deadline';
				break;
			}
			try {
				await pass.pull(station, from, to);
				unanswered = 0;
				out.pulled.push(station);
				await pass.save(null);
			} catch (err) {
				if (isOutOfTime(err)) {
					out.left = stations.length - i;
					out.stopped = 'deadline';
					break;
				}
				if (isStop(err)) {
					out.stop = err;
					out.stopped = stopReason(err);
					break;
				}
				if (!isStationFailure(err)) throw err;
				out.failed.push(station);
				ctx.log('warn', { event: 'dws_station_failed', station, check: failureLabel(err), ...(skipStored ? { from, to } : {}) });
				unanswered = err instanceof DwsUnavailableError ? unanswered + 1 : 0;
				if (unanswered >= MAX_UNAVAILABLE_IN_A_ROW) {
					out.stop = new DwsDownError(unanswered);
					out.stopped = 'unavailable';
					break;
				}
			}
		}
	} catch (err) {
		threw = true;
		throw err;
	} finally {
		await saveOnExit(pass, out.stop, threw);
	}
	return out;
}

/** The daily run (see the header). Throws a DWS stop after saving, so the invocation fails; returns otherwise. */
export async function runDaily(ctx: RunContext): Promise<RunResult> {
	const base = { mode: 'daily' as const, pulled: [] as string[], failed: [] as string[], skipped: 0, requests: 0 };
	const list = await readJsonKey(ctx.store, KEYS.stations, parseStations);
	if (!list) return { ...base, stopped: 'no_stations', lagDays: null };
	const lease = await takeLease(ctx.store, { holder: 'daily', remainingMs: ctx.remainingMs, now: ctx.now });
	if ('busy' in lease) {
		ctx.log('warn', { event: 'dws_lease_busy', holder: lease.busy.holder, until: lease.busy.until });
		const status = await readJsonKey(ctx.store, KEYS.status, parseStatus);
		const result: RunResult = { ...base, stopped: 'busy', lagDays: new Pass(ctx, 'daily', list, status).lagDays() };
		ctx.emitLag(result.lagDays);
		return result;
	}
	try {
		const previous = await readJsonKey(ctx.store, KEYS.status, parseStatus);
		const pass = new Pass(ctx, 'daily', list, previous);
		const now = ctx.now();
		const cooling = coolingUntil(previous);
		if (cooling !== null && now < cooling && !ctx.ignoreStop) {
			// The status is left as it is, so its stop keeps holding until it lapses.
			const result: RunResult = { ...base, stopped: 'cooling', lagDays: pass.lagDays() };
			ctx.emitLag(result.lagDays);
			ctx.log('warn', { event: 'dws_run', reason: previous!.stopped, until: coolingLabel(cooling), ...summary(result) });
			return result;
		}
		const st = pass.stations;
		const current = (s: string) => (st[s]?.currentAt ? Date.parse(st[s]!.currentAt!) : -Infinity);
		const turn = (s: string) => Math.max(current(s), st[s]?.triedAt ? Date.parse(st[s]!.triedAt) : -Infinity);
		const due = list.stations.filter((s) => current(s) <= now - REFRESH_HOURS * 3600_000).sort((a, b) => turn(a) - turn(b) || (a < b ? -1 : 1));
		const to = sastDay(now);
		const loop = await pullEach(ctx, pass, due, { from: addDays(to, -(DWS_WINDOW_DAYS - 1)), to }, false);
		const result: RunResult = { ...base, pulled: loop.pulled, failed: loop.failed, skipped: list.stations.length - due.length, stopped: loop.stopped, requests: ctx.client.requests, lagDays: pass.lagDays() };
		ctx.emitLag(result.lagDays);
		ctx.log(loop.stop ? 'error' : 'info', { event: 'dws_run', ...summary(result) });
		if (loop.stop) throw loop.stop;
		return result;
	} finally {
		await lease.held.release();
	}
}

/** A backfill window's bounds, refused unless they are real days, in order, within one request's span and not after today. */
export function checkWindow(from: unknown, to: unknown, today: string): { from: string; to: string } {
	const day = (v: unknown): v is string => typeof v === 'string' && ISO_DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
	if (!day(from) || !day(to)) throw new StoreFormatError('A backfill window is { from, to } as YYYY-MM-DD');
	if (from > to) throw new StoreFormatError('A backfill window ends before it starts');
	if (daysBetween(from, to) + 1 > DWS_MAX_WINDOW_DAYS) throw new StoreFormatError(`A backfill window spans at most ${DWS_MAX_WINDOW_DAYS} days`);
	if (to > today) throw new StoreFormatError('A backfill window ends after today');
	return { from, to };
}

/** One window of the backfill (see the header). Throws to fail the state machine's item: each error's name says how it is retried. */
export async function runBackfill(ctx: RunContext, window: { from: string; to: string }): Promise<RunResult> {
	const { from, to } = window;
	const list = await readJsonKey(ctx.store, KEYS.stations, parseStations);
	if (!list) throw new StoreFormatError('No station list: upload one with tools/dws-stations.sh (tools/deploy.sh real) first');
	const lease = await takeLease(ctx.store, { holder: 'backfill', remainingMs: ctx.remainingMs, now: ctx.now });
	if ('busy' in lease) throw new LeaseBusyError(lease.busy.holder);
	try {
		const previous = await readJsonKey(ctx.store, KEYS.status, parseStatus);
		const cooling = coolingUntil(previous);
		if (cooling !== null && ctx.now() < cooling && !ctx.ignoreStop) throw new CoolingDownError(previous!.stopped!, coolingLabel(cooling));
		const pass = new Pass(ctx, 'backfill', list, previous);
		const loop = await pullEach(ctx, pass, list.stations, window, true);
		const result: RunResult = { mode: 'backfill', pulled: loop.pulled, failed: loop.failed, skipped: loop.skipped, stopped: loop.stopped, requests: ctx.client.requests, lagDays: null };
		ctx.log(loop.stop || loop.left || loop.failed.length ? 'error' : 'info', { event: 'dws_run', from, to, ...summary(result) });
		if (loop.stop) throw loop.stop;
		if (loop.left) throw new WindowUnfinishedError(loop.left);
		if (loop.failed.length) throw new StationsFailedError(loop.failed.length);
		return result;
	} finally {
		await lease.held.release();
	}
}

/** What a run's log line says: counts, never the station list. */
export const summary = (r: RunResult) => ({ mode: r.mode, stopped: r.stopped, pulled: r.pulled.length, failed: r.failed.length, skipped: r.skipped, requests: r.requests, lagDays: r.lagDays });

export const METRIC_NAMESPACE = 'ewr-compliance/Dws';
export const LAG_METRIC = 'DwsLagDays';

/** The daily run's freshness as a CloudWatch Embedded Metric Format line (infra/dws.tf's lag alarm reads it). */
export function lagMetricLine(lagDays: number, now = Date.now()): string {
	return JSON.stringify({
		_aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [['Pipeline']], Metrics: [{ Name: LAG_METRIC, Unit: 'None' }] }] },
		Pipeline: 'dws',
		[LAG_METRIC]: lagDays
	});
}

/**
 * Straight to stdout: under Lambda's JSON log format a console call would nest it under `message`, and
 * CloudWatch only reads EMF from a top-level `_aws` key (WM's logging/logEvent.ts emitMetricLine).
 */
export function emitLag(lagDays: number | null): void {
	if (lagDays !== null) process.stdout.write(`${lagMetricLine(lagDays)}\n`);
}
