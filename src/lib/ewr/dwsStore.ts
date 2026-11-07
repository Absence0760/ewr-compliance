// Our own store of DWS flow, kept current by scheduled pulls and served from this site under dws/.
// What the browser reads of it, and what the Data source says about it. Pure: no DOM, no fetch.
// The file formats are in docs/architecture.md § DWS store.
import { CALENDAR } from './format.ts';
import type { GaugeLink } from './types.ts';

/** The one format version this app reads. A store written in another is refused, not guessed at. */
export const DWS_STORE_VERSION = 1;

/** One station in dws/index.json. */
export interface DwsStation {
	/** When the last pull that got this station's data ended, ISO 8601 with its offset. */
	fetchedAt: string;
	/** The first and last day of the daily flow in flows-<station>.json, YYYY-MM-DD. */
	covers: { from: string; to: string };
	/** Set by the pipeline when its pulls have stopped keeping this station current. */
	stale: boolean;
	/** True when dws/monthly-<station>.json is there too. Absent is false. */
	monthly: boolean;
}

/** dws/index.json, by station. Every station listed has a dws/flows-<station>.json. */
export interface DwsIndex {
	version: number;
	stations: Record<string, DwsStation>;
}

/** dws/monthly-<station>.json: monthly volumes as text, as gauges.json holds them, and the months to leave out. */
export interface DwsMonthlyFile {
	monthly: string;
	incomplete?: string[];
}

/** Where the store stands for this copy of the site. */
export type DwsState =
	| { status: 'loading' }
	| { status: 'ready'; index: DwsIndex }
	| { status: 'unavailable'; reason: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** dws/index.json checked against its format. Throws, naming what is wrong, rather than show a half-read store. */
export function parseDwsIndex(json: unknown): DwsIndex {
	if (!isObject(json)) throw new Error('dws/index.json is not a JSON object.');
	if (json.version !== DWS_STORE_VERSION) throw new Error(`dws/index.json is format version ${String(json.version)}; this app reads ${DWS_STORE_VERSION}.`);
	if (!isObject(json.stations)) throw new Error('dws/index.json has no stations.');
	const stations: Record<string, DwsStation> = {};
	for (const [station, e] of Object.entries(json.stations)) {
		const bad = (what: string) => new Error(`dws/index.json: ${station} ${what}.`);
		if (!isObject(e)) throw bad('is not an object');
		if (typeof e.fetchedAt !== 'string' || Number.isNaN(Date.parse(e.fetchedAt))) throw bad('has no fetchedAt time');
		const covers = e.covers;
		if (!isObject(covers) || typeof covers.from !== 'string' || typeof covers.to !== 'string' || !DAY.test(covers.from) || !DAY.test(covers.to)) {
			throw bad('has no covers period, from and to as YYYY-MM-DD');
		}
		if (typeof e.stale !== 'boolean') throw bad('has no stale flag');
		if (e.monthly !== undefined && typeof e.monthly !== 'boolean') throw bad('has a monthly flag that is not true or false');
		stations[station] = { fetchedAt: e.fetchedAt, covers: { from: covers.from, to: covers.to }, stale: e.stale, monthly: e.monthly === true };
	}
	return { version: DWS_STORE_VERSION, stations };
}

/** Why the store could not be read. A 404 is a copy of the site without one, such as `pnpm dev` or `pnpm preview`. */
export const dwsUnavailable = (status: number | null, message = ''): DwsState => ({
	status: 'unavailable',
	reason:
		status === 404
			? 'This copy of the site has no DWS store.'
			: status !== null
				? `The DWS store could not be read: HTTP ${status}.`
				: `The DWS store could not be read: ${message}`
});

/** South Africa Standard Time is UTC+2 all year: South Africa keeps no daylight saving. */
const SAST_MS = 2 * 3600000;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * A fetchedAt time in South Africa's time, where DWS and the gauges are, whatever the browser's zone. Worked
 * out here rather than by Intl, whose month names differ between engines ("Sep" and "Sept").
 */
export function fetchedText(iso: string): string {
	const d = new Date(Date.parse(iso) + SAST_MS);
	return `${d.getUTCDate()} ${CALENDAR[d.getUTCMonth() + 1]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} SAST`;
}

/** What a comparison wants of the store: monthly volumes, or daily flow and readings. */
export type DwsWant = 'monthly' | 'instant';

/** Whether the DWS source can be picked for this node, and the line that says what it holds or why not. */
export function dwsOffer(state: DwsState, link: GaugeLink | null, want: DwsWant): { ok: boolean; detail: string } {
	if (!link) return { ok: false, detail: 'Offered for a node with a linked gauge.' };
	if (state.status === 'loading') return { ok: true, detail: 'Checking the store…' };
	if (state.status === 'unavailable') return { ok: false, detail: state.reason };
	const e = state.index.stations[link.station];
	if (!e) return { ok: false, detail: `The store holds nothing for ${link.station} yet.` };
	if (want === 'monthly' && !e.monthly) return { ok: false, detail: `The store has no monthly volumes for ${link.station} yet.` };
	const what = want === 'monthly' ? 'Monthly volumes' : 'Daily flow, and 12-minute readings where DWS has them';
	return { ok: true, detail: `${what}, pulled from DWS. Fetched ${fetchedText(e.fetchedAt)}${e.stale ? ', and out of date' : ''}.` };
}

/** The store's entry for this node's gauge, when the store has been read and holds one. */
export const dwsEntry = (state: DwsState, link: GaugeLink | null): DwsStation | null =>
	(link && state.status === 'ready' && state.index.stations[link.station]) || null;

/** What the comparison says about the store's copy: when it was fetched, what it covers, and whether it is out of date. */
export function dwsStatus(station: string, e: DwsStation): { stale: boolean; text: string } {
	if (e.stale) {
		return {
			stale: true,
			text: `Out of date: the store's pulls of ${station} have stopped keeping it current. Last fetched ${fetchedText(e.fetchedAt)}, with daily flow to ${e.covers.to}.`
		};
	}
	return { stale: false, text: `Fetched ${fetchedText(e.fetchedAt)}, with daily flow from ${e.covers.from} to ${e.covers.to}.` };
}

/** Paths under the site, with no leading slash. */
export const dwsPath = {
	index: 'dws/index.json',
	flows: (station: string) => `dws/flows-${encodeURIComponent(station)}.json`,
	monthly: (station: string) => `dws/monthly-${encodeURIComponent(station)}.json`
} as const;
