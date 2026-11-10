// DWS verified daily flow, from the Hydrological Services site's HyData.aspx page, read as
// project-water-management reads it (backend/src/feeds/sources/dws.ts and packages/engine/src/dws.ts,
// ported here). There is no documented API yet (the plan's Q1): this is the daily table WM reads.
//
//   GET https://www.dws.gov.za/Hydrology/Verified/HyData.aspx
//         ?Station=<code>100.00&DataType=Daily&StartDT=YYYY-MM-DD&EndDT=YYYY-MM-DD&SiteType=RIV
//   → <p><pre> first (the ASP.NET document follows the </pre>), holding a format block and a
//     fixed-width table:
//       POS.  1-8   = Date of daily flow  CCYYMMDD
//       POS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999
//       POS. 20-24  = Quality code
//       DATE     D AVG F/R  QUAL
//       20230101     1.234     1
//       20230102             170        ← a gap: flow blank, code only
//       ZZZZZZZZZZZZ
//     "No data for this period" when there is none. The site can answer HTTP 200 with a Kisters
//     "ScriptServer" error page instead of data: that is DWS's backend failing, and stops the run.
//
// Read defensively: no <pre>, a different header, a flow column in another unit, an impossible or
// repeated date, a flow above DWS_MAX_FLOW or a quality code that won't fit its column fails the page
// (DwsFormatError, with a fixed label for the log) and nothing of it is written.
//
// What the store keeps is EWR's own `.day` layout (renderDay), checked by EWR's own parseDay
// (src/lib/ewr/parsers.ts), so the store can never hold a daily file the app can't read, or reads
// differently: EWR's rules decide what a code means (170 or a blank is missing, 1 and 2 are clean,
// any other code is a real value drawn in its own colour), not this file. Two things are written
// blank, which the app reads as a missing day: a flow column holding text, and a negative figure
// (DWS's -999 placeholders), as the app treats a -9999 in any other flow table.
import { parseDay } from '../../src/lib/ewr/parsers.ts';
import { DwsFormatError, DwsServerError, StoreFormatError } from './errors.ts';

export const DWS_BASE = 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx';

/**
 * The most days one request asks for: two years, as WM's feed. Its first fetch asked for ten years
 * and got the ScriptServer page twice (2026-10-26), so the pipeline asks for little at a time and a
 * longer history goes window by window through the backfill (tools/dws-backfill-plan.mjs).
 */
export const DWS_WINDOW_DAYS = 730;

/** The most one backfill window may span: the site's limit for daily data is 20 years. */
export const DWS_MAX_WINDOW_DAYS = 20 * 365;

/** A DWS river gauge: a drainage letter, a digit, H, three digits. Only these are asked for, with SiteType=RIV. */
export const STATION = /^[A-Z][0-9]H[0-9]{3}$/;

/** The most a listed flow may be: 100 000 m³/s, an order of magnitude above any South African river's peak (WM's bound). */
export const DWS_MAX_FLOW = 100_000;

/** A quality code that fits the .day file's code column, positions 20-24. */
const QUALITY = /^[A-Za-z0-9]{1,5}$/;

/** The flow column, positions 10-18: nine characters. */
const FLOW_WIDTH = 9;

export function dwsUrl(station: string, from: string, to: string): string {
	if (!STATION.test(station)) throw new RangeError('Not a DWS river gauge code');
	const q = new URLSearchParams({ Station: `${station}100.00`, DataType: 'Daily', StartDT: from, EndDT: to, SiteType: 'RIV' });
	return `${DWS_BASE}?${q}`;
}

/** One listed day as the page wrote it: the date, the flow column's text ('' when blank), the quality code ('' when none). */
export interface DayRow {
	day: string;
	flow: string;
	code: string;
}

export interface DwsPage {
	/** Oldest first, one per day. Empty for "No data for this period". */
	rows: DayRow[];
	/** Rows dated outside the window asked for: dropped. */
	outside: number;
	/** Rows whose flow column held text or a negative figure: written blank. */
	blanked: number;
}

const SERVER_ERROR = /scriptserver|can't connect to|unable to establish connection/i;
const M3S = /cubic met(re|er)s?\s*(\/|per)\s*s(ec(ond)?)?\b|\bm(3|³)\s*\/\s*s\b|\bcumecs\b/i;
const DAILY_HEADER = /^DATE (D AVG F\/R|D_AVG_FR) QUAL( |$)/;
const HEADER_LINE = /^\s*DATE(\s|$)/i;
const ROW = /^\d{8}(\s|$)/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NO_DATA = /no data for this period/i;

/** HTML comments removed by a scan (a regex retries from every unclosed "<!--", quadratic on a hostile page). */
function stripHtmlComments(raw: string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const open = raw.indexOf('<!--', at);
		if (open < 0) return out + raw.slice(at);
		out += raw.slice(at, open);
		const close = raw.indexOf('-->', open + 4);
		if (close < 0) return out + raw.slice(open);
		at = close + 3;
	}
}

/** The text of the first <pre>…</pre>, or null, by a scan for the same reason. */
function preText(page: string): string | null {
	const lower = page.toLowerCase();
	for (let at = lower.indexOf('<pre'); at >= 0; at = lower.indexOf('<pre', at + 4)) {
		const next = lower[at + 4];
		if (next !== '>' && next !== undefined && !/\s/.test(next)) continue;
		const open = lower.indexOf('>', at + 4);
		if (open < 0) return null;
		const close = lower.indexOf('</pre>', open + 1);
		return close < 0 ? null : page.slice(open + 1, close);
	}
	return null;
}

/** Every tag removed, repeating until a pass changes nothing (CodeQL js/incomplete-multi-character-sanitization). */
function stripTags(s: string): string {
	for (let prev = ''; prev !== s; ) [prev, s] = [s, s.replace(/<[^>]*>/g, '')];
	return s;
}

const decode = (s: string) =>
	stripTags(s.replace(/<br\s*\/?>/gi, '\n'))
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/** The table text: the decoded <pre> of a page, or the text itself when it is a plain table (a DATE line, no <html>). */
function tableText(page: string): string | null {
	const pre = preText(page);
	if (pre !== null) return decode(pre);
	return /^[ \t]*DATE\s/m.test(page) && !/<html/i.test(page) ? page : null;
}

/** A real calendar day as YYYY-MM-DD, or null (20210230). */
function isoOf(d: string): string | null {
	const y = +d.slice(0, 4);
	const m = +d.slice(4, 6);
	const day = +d.slice(6, 8);
	const t = new Date(Date.UTC(y, m - 1, day));
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

/**
 * A row's fields, read against the header's columns. Numbers sit right-aligned under their labels and a
 * gap row leaves the flow blank ("20210102             170"), so a row with one field after the date
 * is placed by where that field ends: a whole number ending under QUAL is the code, anything else the flow.
 */
function rowFields(line: string, valueEnd: number, qualEnd: number): [string, string, string] {
	const fields = [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], end: m.index + m[0].length }));
	const [d, a, b] = fields;
	if (fields.length > 3) throw new DwsFormatError('columns changed');
	if (!a) return [d!.text, '', ''];
	if (b) return [d!.text, a.text, b.text];
	const underQual = /^\d+$/.test(a.text) && Math.abs(a.end - qualEnd) < Math.abs(a.end - valueEnd);
	return underQual ? [d!.text, '', a.text] : [d!.text, a.text, ''];
}

/**
 * A HyData.aspx daily page, read into its listed days, oldest first. Rows dated outside the window
 * asked for are dropped: a page that ignores the dates asked for must not write days nobody asked for.
 */
export function readPage(raw: string, window: { from: string; to: string }): DwsPage {
	const page = stripHtmlComments(raw);
	if (SERVER_ERROR.test(page)) throw new DwsServerError();
	const body = tableText(page);
	if (body === null) {
		if (NO_DATA.test(page)) return { rows: [], outside: 0, blanked: 0 };
		throw new DwsFormatError('no data table');
	}
	if (NO_DATA.test(body)) return { rows: [], outside: 0, blanked: 0 };
	const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
	const h = lines.findIndex((l) => HEADER_LINE.test(l));
	if (h === -1) throw new DwsFormatError('no DATE header');
	const headerLine = lines[h]!.toUpperCase();
	if (!DAILY_HEADER.test(headerLine.trim().split(/\s+/).join(' '))) throw new DwsFormatError('columns changed');
	const qual = headerLine.search(/\bQUAL\b/);
	const valueEnd = headerLine.slice(0, qual).trimEnd().length;
	const qualEnd = qual + 4;
	// The format block states the flow column's unit; a page that says another is refused, not stored in the wrong unit.
	const valueSpec = lines.slice(0, h).find((l) => /^\s*POS\.\s*10\s*-\s*18\s*=/i.test(l));
	if (valueSpec !== undefined && !(/flow rate/i.test(valueSpec) && M3S.test(valueSpec))) throw new DwsFormatError('not a flow in m3/s');

	const byDay = new Map<string, DayRow>();
	let outside = 0;
	let blanked = 0;
	for (const line of lines.slice(h + 1)) {
		if (!ROW.test(line.trim())) continue;
		const [date, flow, code] = rowFields(line, valueEnd, qualEnd);
		const iso = isoOf(date);
		if (iso === null) throw new DwsFormatError('impossible date');
		if (iso < window.from || iso > window.to) {
			outside++;
			continue;
		}
		if (byDay.has(date)) throw new DwsFormatError('a day listed twice');
		if (code !== '' && !QUALITY.test(code)) throw new DwsFormatError('bad quality code');
		let kept = flow;
		if (flow !== '' && (!NUMBER.test(flow) || Number(flow) < 0)) {
			kept = '';
			blanked++;
		}
		if (kept !== '' && Number(kept) > DWS_MAX_FLOW) throw new DwsFormatError('flow out of range');
		if (kept.length > FLOW_WIDTH) throw new DwsFormatError('flow too wide');
		byDay.set(date, { day: date, flow: kept, code });
	}
	const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
	return { rows, outside, blanked };
}

/** One row in the .day layout: date in 1-8, flow right-aligned in 10-18, code right-aligned in 20-24. */
export const dayLine = (r: DayRow) => `${r.day}${r.flow.padStart(FLOW_WIDTH + 1)}${r.code ? r.code.padStart(6) : ''}`;

/** A row back out of a stored .day file, by the same positions parseDay reads. */
export function lineRow(line: string): DayRow | null {
	if (!/^\d{8}\b/.test(line)) return null;
	return { day: line.slice(0, 8), flow: line.slice(9, 18).trim(), code: line.slice(19, 24).trim() };
}

/**
 * The store's daily file for a station: EWR's .day layout, and checked by EWR's parseDay before it is
 * returned. Every row must come back with its date, its code, and its flow as a number (or missing
 * where the app counts it missing), or this throws rather than write a file the app reads otherwise.
 */
export function renderDay(station: string, rows: DayRow[]): string {
	const text = [
		'DWS verified daily flow (HyData.aspx), kept by the EWR Compliance pipeline',
		'POS.  1-8   = Date of daily flow  CCYYMMDD',
		'POS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999',
		'POS. 20-24  = Quality code',
		'',
		station,
		'',
		'DATE     D AVG F/R  QUAL',
		...rows.map(dayLine),
		'ZZZZZZZZZZZZ',
		''
	].join('\n');
	const points = parseDay(text);
	if (points.length !== rows.length) throw new StoreFormatError('the daily file does not read back as one day a row');
	points.forEach((p, i) => {
		const r = rows[i]!;
		const t = Date.UTC(+r.day.slice(0, 4), +r.day.slice(4, 6) - 1, +r.day.slice(6, 8));
		const v = r.flow === '' || r.code === '170' ? null : Number(r.flow);
		if (p.t !== t || p.v !== v || (p.code ?? '') !== r.code) throw new StoreFormatError('the daily file does not read back as written');
	});
	return text;
}
