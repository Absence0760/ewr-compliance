// Reads observed flow from a file into a FlowSlot. Pure: no DOM and no app state.
// xlsx is loaded on demand so it stays out of the first page bundle.
import { CALENDAR } from './format.ts';
import { buildFlow, dayRows, detectLayout, isDay, isMon, monRows, parseDay, parseDelimited, parseMon } from './parsers.ts';
import type { FlowSlot } from '#lib/state/app.svelte.ts';
import type { Cell, FlowUnit, FlowWant, Sheet } from './types.ts';

type FlowFile = Pick<File, 'name' | 'size' | 'arrayBuffer' | 'text'>;

export const looksLikeBook = (name: string) => /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(name);

// Limits on what a loaded file can make the browser do. The longest flow this app reads is 12-minute
// readings, 120 a day, so a decade of them is 438 300 rows in a few columns: tens of MB as text, less
// as a workbook. Each limit leaves that with room to spare, and stops a small crafted file from
// claiming a sheet of 17 billion cells (A1:XFD1048576) that reading it would fill in, cell by cell.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SHEET_ROWS = 500_000;
export const MAX_SHEET_CELLS = 5_000_000;

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** Refuse a file too large to be a flow file before any of it is read. */
export function checkSize(file: Pick<File, 'name' | 'size'>): void {
	if (file.size > MAX_FILE_BYTES) {
		throw new Error(`the file is ${mb(file.size)}, more than the ${mb(MAX_FILE_BYTES)} a flow file can be. Split it into shorter periods.`);
	}
}

type Range = { s: { r: number; c: number }; e: { r: number; c: number } };

/** The range a sheet's cells actually fill. A file's own dimension can claim far more than it holds. */
export function usedRange(sheet: Record<string, unknown>, decode: (a: string) => { r: number; c: number }): Range | null {
	let range: Range | null = null;
	for (const key of Object.keys(sheet)) {
		if (key[0] === '!') continue;
		const { r, c } = decode(key);
		if (!range) range = { s: { r, c }, e: { r, c } };
		else {
			range.s.r = Math.min(range.s.r, r);
			range.s.c = Math.min(range.s.c, c);
			range.e.r = Math.max(range.e.r, r);
			range.e.c = Math.max(range.e.c, c);
		}
	}
	return range;
}

/**
 * Serials stay numbers, so a date reads the same in every browser timezone.
 * This runs on the main thread rather than in a Worker: the limits above keep the work in proportion to
 * the file's size, so a crafted file can no longer hang the tab, and a Worker would be a second code path
 * that Vitest's Node environment cannot run.
 */
export async function readBook(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<Sheet[]> {
	checkSize(file);
	const [XLSX, buf] = await Promise.all([import('xlsx'), file.arrayBuffer()]);
	// One row past the limit is read, so a table that runs past it is refused rather than cut short.
	const wb = XLSX.read(buf, { type: 'array', cellDates: false, sheetRows: MAX_SHEET_ROWS + 1 });
	return wb.SheetNames.map((name) => {
		const ws = wb.Sheets[name];
		const used = usedRange(ws, XLSX.utils.decode_cell);
		if (!used) return { name, rows: [], widths: null, layout: detectLayout([]) };
		// The file's own start is kept, so row and column numbers keep their places; only its end is cut back.
		const claimed = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : used;
		const start = { r: Math.min(claimed.s.r, used.s.r), c: Math.min(claimed.s.c, used.s.c) };
		const rows = used.e.r + 1;
		const cells = (used.e.r - start.r + 1) * (used.e.c - start.c + 1);
		if (rows > MAX_SHEET_ROWS) throw new Error(`sheet "${name}" has more than ${MAX_SHEET_ROWS.toLocaleString('en-ZA')} rows. Split it into shorter periods.`);
		if (cells > MAX_SHEET_CELLS) {
			throw new Error(`sheet "${name}" spans ${cells.toLocaleString('en-ZA')} cells, more than the ${MAX_SHEET_CELLS.toLocaleString('en-ZA')} a flow table can. Remove the cells far from the table.`);
		}
		ws['!ref'] = XLSX.utils.encode_range({ s: start, e: used.e });
		const data = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null });
		return { name, rows: data, widths: null, layout: detectLayout(data) };
	});
}

export async function readText(file: Pick<File, 'name' | 'size' | 'text'>): Promise<Sheet[]> {
	checkSize(file);
	const text = await file.text();
	if (isMon(text) || isDay(text)) {
		const rows = isMon(text) ? monRows(parseMon(text)) : dayRows(parseDay(text));
		return [{ name: file.name, rows, widths: null, layout: detectLayout(rows) }];
	}
	const { rows, widths } = parseDelimited(text);
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
