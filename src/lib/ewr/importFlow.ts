// Reads observed flow from a file or an API body into a FlowSlot. Pure: no DOM and no app state.
// xlsx is loaded on demand so it stays out of the first page bundle.
import { CALENDAR } from './format.ts';
import { buildFlow, detectLayout, parseDelimited } from './parsers.ts';
import type { FlowSlot } from '#lib/state/app.svelte.ts';
import type { Cell, FlowUnit, FlowWant, Sheet } from './types.ts';

type FlowFile = Pick<File, 'name' | 'arrayBuffer' | 'text'>;

export const looksLikeBook = (name: string) => /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(name);

/** Serials stay numbers, so a date reads the same in every browser timezone. */
export async function readBook(file: Pick<File, 'arrayBuffer'>): Promise<Sheet[]> {
	const [XLSX, buf] = await Promise.all([import('xlsx'), file.arrayBuffer()]);
	const wb = XLSX.read(buf, { type: 'array', cellDates: false });
	return wb.SheetNames.map((name) => {
		const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });
		return { name, rows, widths: null, layout: detectLayout(rows) };
	});
}

export async function readText(file: Pick<File, 'name' | 'text'>): Promise<Sheet[]> {
	const { rows, widths } = parseDelimited(await file.text());
	return [{ name: file.name, rows, widths, layout: detectLayout(rows, widths) }];
}

/** The sheet holding the most usable data of the kind this comparison needs. */
export function bestSheet(sheets: Sheet[], want: FlowWant): Sheet {
	const score = (s: Sheet) => {
		if (!s.layout) return -1;
		try {
			const f = buildFlow(s.rows, s.widths, s.layout, { unit: s.layout.unit || 'mm3' });
			return want === 'monthly' ? f.months : (f.points?.length ?? 0);
		} catch {
			return -1;
		}
	};
	return sheets
		.map((s) => ({ s, n: score(s) }))
		.reduce((best, x) => (x.n > best.n ? x : best)).s;
}

/** Instantaneous flow is m³/s in this app; applyImport refuses anything that declares otherwise. */
const defaultUnit = (s: Sheet, want: FlowWant): FlowUnit => (want === 'instant' ? 'cumec' : s.layout?.unit || 'mm3');

export const flowMessage = (level: 'info' | 'error', text: string) => ({ level, text });

/** Rebuild the flow from a slot's sheet and settings, with the status line that goes with it. */
export function applyImport(slot: FlowSlot, want: FlowWant): FlowSlot {
	const sh = slot.sheet;
	if (!sh) return { ...slot, flow: null, message: null };
	if (!sh.layout) {
		const text = `No flow table found in "${sh.name}". Expected a row of month names above year rows, or Date and Flow columns.`;
		return { ...slot, flow: null, message: flowMessage('error', text) };
	}
	const f = buildFlow(sh.rows, sh.widths, sh.layout, { unit: slot.unitIn, yearIs: slot.yearIs });
	const fail = (text: string) => ({ ...slot, flow: null, message: flowMessage('error', text) });
	if (!f.months && !f.points?.some((p) => p.v !== null)) return fail('No flow values were found.');
	if (want === 'monthly') {
		if (!f.first || !f.last) return fail(`This data covers less than a full month of ${f.step} readings. Use it in the Real Time Comparison.`);
		const span = `${CALENDAR[f.first.m]} ${f.first.y} to ${CALENDAR[f.last.m]} ${f.last.y}`;
		const layout = sh.layout.kind === 'matrix' ? 'year rows by month columns' : `${f.step} date column`;
		const text = `Read ${f.months} months, ${span}${f.missing ? `, with ${f.missing} missing` : ''}. Layout: ${layout}.`;
		return { ...slot, flow: f, message: flowMessage('info', text) };
	}
	if (!f.points?.length) {
		return fail('This data has monthly values only. The Real Time Comparison needs dated readings; use the Historical Comparison for it.');
	}
	// A volume per reading has no defined interval, so it cannot be converted.
	if (sh.layout.unit === 'mm3') return fail('This data is in Mm³. The Real Time Comparison needs flow in m³/s, so it was not loaded.');
	const pts = f.points.filter((p) => p.v !== null);
	const day = (t: number) => new Date(t).toISOString().slice(0, 10);
	const text = `Read ${pts.length.toLocaleString()} readings, ${day(pts[0].t)} to ${day(pts[pts.length - 1].t)}.`;
	return { ...slot, flow: f, message: flowMessage('info', text) };
}

/** A file read into a fresh slot, on the sheet most likely to be the one wanted. */
export async function importFile(file: FlowFile, want: FlowWant): Promise<FlowSlot> {
	const sheets = await (looksLikeBook(file.name) ? readBook(file) : readText(file));
	const sheet = bestSheet(sheets, want);
	return applyImport(
		{ sheets, sheet, name: file.name, unitIn: defaultUnit(sheet, want), yearIs: 'start', flow: null, message: null },
		want
	);
}

export function pickSheet(slot: FlowSlot, name: string, want: FlowWant): FlowSlot {
	const sheet = slot.sheets.find((s) => s.name === name) ?? slot.sheet;
	if (!sheet) return slot;
	return applyImport({ ...slot, sheet, unitIn: defaultUnit(sheet, want) }, want);
}

/** Real time asks for the last 31 days. */
export const API_DAYS = 31;

/** A whole record is far larger than 31 days of readings, so it gets longer. */
const API_TIMEOUT_INSTANT_MS = 60_000;
const API_TIMEOUT_MONTHLY_MS = 180_000;

export const apiTimeoutMs = (want: FlowWant) => (want === 'monthly' ? API_TIMEOUT_MONTHLY_MS : API_TIMEOUT_INSTANT_MS);

/** Monthly asks for the whole record. Every series in static/data starts in 1920 or later, so {from} cuts nothing off. */
const RECORD_START = Date.UTC(1900, 0, 1);

/** The period an API request asks for. */
export function apiWindow(want: FlowWant, now: Date): { from: Date; to: Date } {
	const from = want === 'monthly' ? RECORD_START : now.getTime() - API_DAYS * 86400000;
	return { from: new Date(from), to: now };
}

/** What stops a request being sent. An address with no scheme would fetch from this site instead. */
export function apiInputProblem(url: string, station: string): string {
	if (!url) return 'Enter the API address first.';
	if (!/^https?:\/\//i.test(url)) return 'The API address must start with http:// or https://.';
	if (url.includes('{station}') && !station) return 'Enter the station: the API address uses {station}.';
	return '';
}

/** Fill the {station}, {from} and {to} of an endpoint template. */
export function apiUrl(template: string, station: string, from: Date, to: Date): string {
	return template
		.replaceAll('{station}', encodeURIComponent(station))
		.replaceAll('{from}', from.toISOString())
		.replaceAll('{to}', to.toISOString());
}

const SAID_MAX = 200;

/** The text of an API's own message: a string, an object holding one, or a list of those. */
function saidIn(v: unknown): string {
	if (typeof v === 'string') return v.trim().slice(0, SAID_MAX);
	if (Array.isArray(v)) return saidIn(v[0]);
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return saidIn(o.message) || saidIn(o.detail);
	}
	return '';
}

const isRow = (v: unknown): v is Record<string, Cell> => typeof v === 'object' && v !== null;

/**
 * Parsed JSON as rows, or what is wrong with it. An error field wins over any rows beside it. A
 * column called plain "time" holds the full date and time here, where the layout detector would
 * read it as the time half of a date. Keys come from every row, as a row may leave out a null.
 */
function jsonRows(json: unknown): Cell[][] | string {
	const o = (Array.isArray(json) ? {} : json) as Record<string, unknown>;
	const error = saidIn(o.error) || saidIn(o.errors);
	if (error) return `The API reported an error: ${error}`;
	const list = Array.isArray(json) ? json : o.data || o.rows;
	const said = saidIn(o.message) || saidIn(o.detail);
	if (!Array.isArray(list)) {
		if (said) return `The API said: ${said}`;
		const found = Object.keys(o).slice(0, 8).join(', ') || 'nothing';
		return `The API response has no rows. Expected a JSON list, or one under "data" or "rows". Found: ${found}.`;
	}
	if (!list.length) return `The API returned no rows.${said ? ` It said: ${said}` : ''}`;
	if (!list.every(isRow)) return 'The API returned a JSON list whose items are not rows.';
	const keys = [...new Set(list.flatMap((row) => Object.keys(row)))];
	const head = keys.map((k) => (/^time$/i.test(k) && !keys.some((x) => /^date/i.test(x)) ? 'datetime' : k));
	return [head, ...list.map((row) => keys.map((k) => row[k] ?? null))];
}

/** An API response as a sheet, or what is wrong with it: JSON rows or CSV, and nothing else. */
export function apiSheet(body: string): { sheet: Sheet; problem: string } {
	const text = body.replace(/^﻿/, '').trim();
	const sheet = (rows: Cell[][], widths: number[][] | null = null): Sheet => ({ name: 'API', rows, widths, layout: detectLayout(rows, widths) });
	const refuse = (problem: string) => ({ sheet: sheet([]), problem });
	if (!text) return refuse('The API returned an empty response.');
	if (text.startsWith('<')) return refuse('The API returned HTML or XML, not JSON rows or CSV. It may be a login or error page.');
	let rows: Cell[][], widths: number[][] | null = null;
	if (/^[[{]/.test(text)) {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch (err) {
			return refuse(`The API response looks like JSON but cannot be read: ${(err as Error).message}`);
		}
		const read = jsonRows(json);
		if (typeof read === 'string') return refuse(read);
		rows = read;
	} else {
		({ rows, widths } = parseDelimited(text));
	}
	const out = sheet(rows, widths);
	if (out.layout) return { sheet: out, problem: '' };
	const began = text.slice(0, 60).replace(/\s+/g, ' ');
	return { sheet: out, problem: `The API response has no flow table. Expected JSON rows or CSV with a date and a flow, or a year with month columns. It began: ${began}` };
}

/**
 * A fetched body into a fresh slot. Real-time flow is m³/s, as the brief says, and a response
 * declaring Mm³ is refused. Monthly flow is Mm³ per month unless the response names its unit, and
 * the user can change that.
 */
export function importApi(body: string, station: string, want: FlowWant): FlowSlot {
	const { sheet, problem } = apiSheet(body);
	const slot: FlowSlot = { sheets: [sheet], sheet, name: station || 'API', unitIn: defaultUnit(sheet, want), yearIs: 'start', flow: null, message: null };
	return problem ? { ...slot, message: flowMessage('error', problem) } : applyImport(slot, want);
}

/** A non-2xx response, with whatever the body says about it. */
export function apiHttpFailure(status: number, body: string): string {
	const { problem } = apiSheet(body);
	return `API request failed: HTTP ${status}.${problem ? ` ${problem}` : ''}`;
}

/** fetch rejects with a TypeError, and no detail, when a server is out of reach or refuses CORS. */
export function apiRequestFailure(err: Error, want: FlowWant): string {
	if (err.name === 'TimeoutError') return `API request failed: no full response within ${apiTimeoutMs(want) / 1000} seconds. The server may be slow or not responding.`;
	return `API request failed: ${err.message}.${err instanceof TypeError ? ' The address may be wrong, the server down, or it may not allow cross-origin requests from this site.' : ''}`;
}
