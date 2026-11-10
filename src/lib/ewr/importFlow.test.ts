import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { applyImport, bestSheet, importFile, looksLikeBook, MAX_FILE_BYTES, MAX_SHEET_ROWS, pickSheet, readBook, readText } from './importFlow.ts';
import type { Cell } from './types.ts';

const MM3_REFUSED = 'This data is in Mm³. The Real Time Comparison needs flow in m³/s, so it was not loaded.';
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

function book(sheets: Record<string, Cell[][]>): File {
	const wb = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as unknown[][]), name);
	return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'flow.xlsx');
}

const monthly: Cell[][] = [
	['Monthly flow, Mm3'],
	['Year', ...MONTHS],
	[2000, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	[2001, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
];

// As a gauge workbook is laid out: a tab of EWR text, the 12-minute readings, and a short summary by day.
function rawSheet(): Cell[][] {
	const rows: Cell[][] = [['Station'], ['Date', 'Time', 'Stage(m)', 'Flow(m^3/s)']];
	for (let i = 0; i < 300; i++) {
		const day = 45976 + Math.floor(i / 120);
		rows.push([day, (i % 120) / 120, 0.1, 0.5]);
	}
	return rows;
}
const summary: Cell[][] = [
	['Day', 'EWR (m3/s)', 'Flow (m3/s)'],
	...Array.from({ length: 30 }, (_, i): Cell[] => [i + 1, 0.64, null])
];
const tabText: Cell[][] = [['Desktop', 'Version', '2'], ['Summary', 'of', 'Desktop']];

describe('readBook', () => {
	it('keeps dates as serial numbers', async () => {
		const sheets = await readBook(book({ 'Raw Data': rawSheet() }));
		expect(sheets[0].rows[2][0]).toBe(45976);
		expect(sheets[0].layout?.kind).toBe('series');
	});
});

// A small workbook whose sheet XML is rewritten after writing, as a crafted file would be: a claimed
// dimension, or cells placed far from the table, that SheetJS's writer could not produce in reasonable time.
function crafted(edit: (xml: string) => string): File {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthly as unknown[][]), 'Flow');
	const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
	const i = zip.FullPaths.findIndex((p: string) => p.endsWith('worksheets/sheet1.xml'));
	const entry = zip.FileIndex[i];
	entry.content = new TextEncoder().encode(edit(new TextDecoder().decode(entry.content as Uint8Array)));
	return new File([XLSX.CFB.write(zip, { fileType: 'zip', type: 'array' }) as Uint8Array<ArrayBuffer>], 'flow.xlsx');
}

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; result: T | Error }> {
	const t = performance.now();
	const result = await run().catch((e: Error) => e);
	return { ms: performance.now() - t, result };
}

describe('readBook limits', () => {
	it('reads only the cells a sheet holds when its dimension claims the whole grid', async () => {
		const file = crafted((x) => x.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>'));
		const { ms, result } = await timed(() => readBook(file));
		expect(ms).toBeLessThan(1000);
		expect(result).not.toBeInstanceOf(Error);
		const sheets = result as Awaited<ReturnType<typeof readBook>>;
		expect(sheets[0].rows).toHaveLength(monthly.length);
		expect(sheets[0].rows[1]).toHaveLength(13);
		expect(sheets[0].rows[2]).toEqual(monthly[2]);
	});

	it('refuses a sheet with a cell placed far from the table, quickly', async () => {
		const far = '<row r="400000"><c r="XFD400000"><v>1</v></c></row></sheetData>';
		const file = crafted((x) => x.replace('</sheetData>', far));
		const { ms, result } = await timed(() => readBook(file));
		expect(ms).toBeLessThan(1000);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toMatch(/^sheet "Flow" spans [\d\s,]+ cells, more than the/);
	});

	it('refuses a sheet with more rows than a flow table has, rather than cutting it short', async () => {
		// A table that runs past the limit has a row just past it, which is read so the sheet can be refused.
		const row = (r: number) => `<row r="${r}"><c r="A${r}"><v>1</v></c></row>`;
		const last = `${row(MAX_SHEET_ROWS)}${row(MAX_SHEET_ROWS + 1)}${row(MAX_SHEET_ROWS + 2)}</sheetData>`;
		const { ms, result } = await timed(() => readBook(crafted((x) => x.replace('</sheetData>', last))));
		expect(ms).toBeLessThan(1000);
		expect((result as Error).message).toMatch(/^sheet "Flow" has more than [\d\s,]+ rows/);
	});

	it('keeps the file\'s own start, so a table that starts at B2 keeps its blank first row and column', async () => {
		const ws = XLSX.utils.aoa_to_sheet([[null, null], [null, 'Year']]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'S');
		const sheets = await readBook(new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'f.xlsx'));
		expect(sheets[0].rows).toEqual([[null, null], [null, 'Year']]);
	});

	it('refuses a file too large to be a flow file before reading it', async () => {
		let read = false;
		const huge = { name: 'big.xlsx', size: MAX_FILE_BYTES + 1, arrayBuffer: async () => ((read = true), new ArrayBuffer(0)), text: async () => '' };
		await expect(readBook(huge)).rejects.toThrow(/^the file is \d+ MB, more than the 100 MB a flow file can be/);
		await expect(readText({ ...huge, name: 'big.txt' })).rejects.toThrow(/more than the 100 MB/);
		expect(read).toBe(false);
	});
});

describe('bestSheet', () => {
	it('picks the raw readings for real time, whatever the sheet order', async () => {
		const sheets = await readBook(book({ 'tab ewr': tabText, Nov: summary, 'Raw Data': rawSheet() }));
		expect(bestSheet(sheets, 'instant').name).toBe('Raw Data');
		expect(bestSheet([...sheets].reverse(), 'instant').name).toBe('Raw Data');
	});

	it('picks the monthly table for the historical comparison', async () => {
		const sheets = await readBook(book({ Notes: tabText, Flow: monthly }));
		expect(bestSheet(sheets, 'monthly').name).toBe('Flow');
	});

	it('falls back to the first sheet when none has flow', async () => {
		const sheets = await readBook(book({ A: tabText, B: tabText }));
		expect(bestSheet(sheets, 'monthly').name).toBe('A');
	});
});

describe('importFile', () => {
	it('reads a monthly workbook and reports what it found', async () => {
		const s = await importFile(book({ Notes: tabText, Flow: monthly }), 'monthly');
		expect(s.sheet?.name).toBe('Flow');
		expect(s.unitIn).toBe('mm3');
		expect(s.flow?.months).toBe(24);
		expect(s.message).toEqual({
			level: 'info',
			text: 'Read 24 months, Oct 2000 to Sep 2002. Layout: year rows by month columns.'
		});
	});

	it('the year label can mean the end of the hydrological year', async () => {
		const s = await importFile(book({ Flow: monthly }), 'monthly');
		const end = applyImport({ ...s, yearIs: 'end' }, 'monthly');
		expect(end.flow?.first).toMatchObject({ y: 1999, m: 10 });
	});

	it('rebuilds in the other unit', async () => {
		const s = await importFile(book({ Flow: monthly }), 'monthly');
		const c = applyImport({ ...s, unitIn: 'cumec' }, 'monthly');
		// October 2000, 1 m³/s for 31 days.
		expect(c.flow?.first?.v).toBeCloseTo(2.6784, 4);
	});

	it('reads the 12-minute sheet for real time, in m³/s', async () => {
		const s = await importFile(book({ 'tab ewr': tabText, 'Raw Data': rawSheet() }), 'instant');
		expect(s.sheet?.name).toBe('Raw Data');
		expect(s.unitIn).toBe('cumec');
		expect(s.flow?.step).toBe('instantaneous');
		expect(s.flow?.points).toHaveLength(300);
		expect(s.message?.level).toBe('info');
		expect(s.message?.text).toContain('2025-11-15 to 2025-11-17');
	});

	it('reads a text file', async () => {
		const text = ['Year  Oct  Nov  Dec  Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep', '2000  1 2 3 4 5 6 7 8 9 10 11 12'].join('\n');
		const s = await importFile(new File([text], 'flow.txt'), 'monthly');
		expect(s.flow?.months).toBe(12);
	});

	it('says which comparison a file belongs to', async () => {
		const toReal = await importFile(book({ Flow: monthly }), 'instant');
		expect(toReal.flow).toBeNull();
		expect(toReal.message?.level).toBe('error');
		expect(toReal.message?.text).toContain('monthly values only');
		const short = rawSheet().slice(0, 40);
		const toHist = await importFile(book({ 'Raw Data': short }), 'monthly');
		expect(toHist.flow).toBeNull();
		expect(toHist.message?.text).toContain('Real Time Comparison');
	});

	it('refuses readings that declare Mm³ for real time, by column or by title', async () => {
		const byColumn = rawSheet().map((row, i) => (i === 1 ? ['Date', 'Time', 'Stage(m)', 'Flow (Mm3)'] : row));
		const byTitle = rawSheet().map((row, i) => (i === 0 ? ['Flow in Mm3'] : i === 1 ? ['Date', 'Time', 'Stage(m)', 'Flow'] : row));
		for (const rows of [byColumn, byTitle]) {
			const s = await importFile(book({ 'Raw Data': rows }), 'instant');
			expect(s.flow).toBeNull();
			expect(s.unitIn).toBe('cumec');
			expect(s.message).toEqual({ level: 'error', text: MM3_REFUSED });
		}
	});

	it('leaves the same readings to the historical comparison, by its own rules', async () => {
		const rows = rawSheet().map((row, i) => (i === 1 ? ['Date', 'Time', 'Stage(m)', 'Flow (Mm3)'] : row));
		const s = await importFile(book({ 'Raw Data': rows }), 'monthly');
		expect(s.unitIn).toBe('mm3');
		expect(s.message?.text).not.toBe(MM3_REFUSED);
	});

	it('still sends a monthly table in Mm³ to the historical comparison from real time', async () => {
		const s = await importFile(book({ Flow: monthly }), 'instant');
		expect(s.message?.text).toContain("use the Historical Comparison's Monthly volumes");
	});

	it('takes 12-minute readings as daily flow too, averaged to the day', async () => {
		const s = await importFile(book({ 'Raw Data': rawSheet() }), 'daily');
		expect(s.unitIn).toBe('cumec');
		expect(s.flow?.points).toHaveLength(300);
		expect(s.message?.text).toBe('Read 300 readings, 2025-11-15 to 2025-11-17.');
	});

	it('sends a monthly table from daily flow to monthly volumes', async () => {
		const s = await importFile(book({ Flow: monthly }), 'daily');
		expect(s.flow).toBeNull();
		expect(s.message?.text).toBe("This data has monthly values only. Daily flow needs dated flow; use the Historical Comparison's Monthly volumes for it.");
	});

	it('reports a sheet with no flow table', async () => {
		const s = await importFile(book({ Notes: tabText }), 'monthly');
		expect(s.flow).toBeNull();
		expect(s.message?.text).toContain('No flow table found in "Notes"');
	});

	it('reports dated rows that hold no values at all', async () => {
		const rows = ['Date,Flow', ...Array.from({ length: 30 }, (_, i) => `2025-01-01 ${String(i).padStart(2, '0')}:00,`)];
		const s = await importFile(new File([rows.join('\n')], 'flow.csv'), 'instant');
		expect(s.flow).toBeNull();
		expect(s.message?.text).toBe('No flow values were found.');
	});
});

describe('pickSheet', () => {
	it('refuses a sheet in Mm³ for real time, and keeps the m³/s unit on the way back', async () => {
		const mm3 = rawSheet().map((row, i) => (i === 1 ? ['Date', 'Time', 'Stage(m)', 'Flow (Mm3)'] : row));
		const s = await importFile(book({ Good: rawSheet(), Bad: mm3 }), 'instant');
		expect(s.flow).not.toBeNull();
		const bad = pickSheet(s, 'Bad', 'instant');
		expect(bad.flow).toBeNull();
		expect(bad.message?.text).toBe(MM3_REFUSED);
		const back = pickSheet(bad, 'Good', 'instant');
		expect(back.unitIn).toBe('cumec');
		expect(back.flow?.points).toHaveLength(300);
	});

	it('switches sheet and takes up that sheet\'s unit', async () => {
		const cumec: Cell[][] = [['Flow in m3/s'], ['Year', ...MONTHS], [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]];
		const s = await importFile(book({ Flow: monthly, Other: cumec }), 'monthly');
		const o = pickSheet(s, 'Other', 'monthly');
		expect(o.sheet?.name).toBe('Other');
		expect(o.unitIn).toBe('cumec');
		expect(o.flow?.months).toBe(12);
	});
});

describe('looksLikeBook', () => {
	it('goes by extension', () => {
		expect(looksLikeBook('A.XLSX')).toBe(true);
		expect(looksLikeBook('a.ods')).toBe(true);
		expect(looksLikeBook('a.txt')).toBe(false);
	});
});

describe('a DWS monthly volume file', () => {
	const cell = (v: string, flag = ' ') => ` ${v.padStart(6)} ${flag}`;
	const rest = Array.from({ length: 10 }, () => cell('1.00'));
	const text = ['MONTHLY VOLUMES X0H001', `2000/2001${[cell('2.00'), cell('4.00', '#'), ...rest].join('')}    #`, `2001/2002${[cell('', '#'), cell('6.00'), ...rest].join('')}    #`].join('\r\n');
	const file = { name: 'X0H001.mon', size: text.length, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

	it('loads with hydrological years and every # month missing', async () => {
		const slot = await importFile(file, 'monthly');
		expect(slot.unitIn).toBe('mm3');
		expect(slot.message?.text).toBe('Read 22 months, Oct 2000 to Sep 2002, with 2 missing. Layout: year rows by month columns.');
		const at = (y: number, m: number) => slot.flow!.records.find((r) => r.y === y && r.m === m)?.v;
		expect(at(2000, 10)).toBe(2);
		expect(at(2000, 11)).toBeNull();
		expect(at(2001, 10)).toBeNull();
		expect(at(2001, 11)).toBe(6);
	});
});

describe('a DWS daily flow file', () => {
	const row = (date: string, v: string, code: string) => `${date}${v.padStart(10)}${code.padStart(6)}`;
	const text = ['DATE     D AVG F/R  QUAL', row('20030101', '1.000', '1'), row('20030102', '', '170'), row('20030103', '3.000', '91')].join('\r\n');
	const file = { name: 'X0H001.day', size: text.length, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

	it("loads for the Historical Comparison's daily flow in m³/s, with missing days and codes kept", async () => {
		const slot = await importFile(file, 'daily');
		expect(slot.unitIn).toBe('cumec');
		expect(slot.message?.text).toBe('Read 2 days, 2003-01-01 to 2003-01-03.');
		expect(slot.flow?.points?.map((p) => [p.v, p.code])).toEqual([[1, '1'], [null, '170'], [3, '91']]);
	});

	it('is history, so the Real Time Comparison sends it to daily flow', async () => {
		const slot = await importFile(file, 'instant');
		expect(slot.flow).toBeNull();
		expect(slot.message).toEqual({ level: 'error', text: "This is daily flow, not 12-minute readings. Use it in the Historical Comparison's Daily flow." });
	});
});

describe('a monthly table worked up from a daily file', () => {
	const row = (y: number, first: string) => `${y}${[first, ...Array.from({ length: 11 }, () => '1.000')].map((c) => c.padStart(9)).join('')}`;
	const text = ['File Name : x0h001.mon   (from daily file : x0h001.day, dated: )', 'Units     : M.m3', 'Year      Oct      Nov      Dec', row(2000, '3.890+'), row(2001, '2.000')].join('\r\n');
	const file = { name: 'X0H001.MON', size: text.length, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

	it('counts a patched + month, and reads the table by its own format', async () => {
		const slot = await importFile(file, 'monthly');
		const at = (y: number, m: number) => slot.flow!.records.find((r) => r.y === y && r.m === m)?.v;
		expect(at(2000, 10)).toBe(3.89);
		expect(at(2001, 10)).toBe(2);
		expect(slot.flow?.missing).toBe(0);
	});
});
