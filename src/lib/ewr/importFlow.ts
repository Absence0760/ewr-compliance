// Reads observed flow from a file into a FlowSlot. Pure: no DOM and no app state.
// xlsx is loaded on demand so it stays out of the first page bundle.
import { CALENDAR } from './format.ts';
import { buildFlow, dayRows, detectLayout, isDay, isMon, monRows, parseDay, parseDelimited, parseMon } from './parsers.ts';
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
