import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
	apiHttpFailure, apiInputProblem, apiRequestFailure, apiSheet, apiTimeoutMs, apiUrl, apiWindow, applyImport, bestSheet, importApi, importFile, looksLikeBook, pickSheet, readBook
} from './importFlow.ts';
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
		expect(s.message?.text).toContain('use the Historical Comparison');
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

describe('API', () => {
	const matrixRows = [2000, 2001].map((year, k) => ({ Year: year, ...Object.fromEntries(MONTHS.map((m, i) => [m, i + 1 + k])) }));
	const from = new Date('2025-11-01T00:00:00Z'), to = new Date('2025-12-02T00:00:00Z');

	it('fills the endpoint template', () => {
		expect(apiUrl('https://x/f?s={station}&a={from}&b={to}', 'X0 H001', from, to)).toBe(
			'https://x/f?s=X0%20H001&a=2025-11-01T00:00:00.000Z&b=2025-12-02T00:00:00.000Z'
		);
	});

	it('asks for 31 days of real-time readings, and the whole record of monthly volumes and daily flow', () => {
		const now = new Date('2025-12-02T00:00:00Z');
		expect(apiWindow('readings', now)).toEqual({ from: new Date('2025-11-01T00:00:00Z'), to: now });
		expect(apiWindow('monthly', now)).toEqual({ from: new Date('1900-01-01T00:00:00Z'), to: now });
		expect(apiWindow('daily', now)).toEqual({ from: new Date('1900-01-01T00:00:00Z'), to: now });
	});

	it('stops a request that cannot be right', () => {
		expect(apiInputProblem('', '')).toBe('Enter the API address first.');
		expect(apiInputProblem('flow.dws.gov.za/x', '')).toBe('The API address must start with http:// or https://.');
		expect(apiInputProblem('https://x/f?s={station}', '')).toBe('Enter the station: the API address uses {station}.');
		expect(apiInputProblem('https://x/f?s={station}', 'X0H001')).toBe('');
		expect(apiInputProblem('https://x/f', '')).toBe('');
	});

	describe('real time', () => {
		it('reads JSON rows, including flows under 1 m³/s under a plain "time" column', () => {
			const body = JSON.stringify([
				{ time: '2025-11-26T00:00:00', flow: 0.93 },
				{ time: '2025-11-26T00:12:00', flow: 0.92 }
			]);
			const s = importApi(body, 'X0H001', 'readings');
			expect(s.name).toBe('X0H001');
			expect(s.unitIn).toBe('cumec');
			expect(s.flow?.points?.map((p) => p.v)).toEqual([0.93, 0.92]);
		});

		it('reads rows wrapped in data', () => {
			const s = importApi(JSON.stringify({ data: [{ date: '2025-11-26 00:00', flow: 1.5 }, { date: '2025-11-26 00:12', flow: 1.4 }] }), '', 'readings');
			expect(s.name).toBe('API');
			expect(s.flow?.points).toHaveLength(2);
		});

		it('keeps a flow column the first row leaves out', () => {
			const body = JSON.stringify([{ date: '2025-11-26 00:00' }, { date: '2025-11-26 00:12', flow: 1.4 }, { date: '2025-11-26 00:24', flow: 1.3 }]);
			expect(importApi(body, '', 'readings').flow?.points?.map((p) => p.v)).toEqual([null, 1.4, 1.3]);
		});

		it('refuses readings that declare Mm³', () => {
			const body = JSON.stringify([{ date: '2025-11-26 00:00', 'Flow Mm3': 1 }, { date: '2025-11-26 00:12', 'Flow Mm3': 1 }]);
			const s = importApi(body, 'X0H001', 'readings');
			expect(s.flow).toBeNull();
			expect(s.message).toEqual({ level: 'error', text: MM3_REFUSED });
		});

		it('takes readings that name no unit as m³/s', () => {
			const body = JSON.stringify([{ date: '2025-11-26 00:00', flow: 1 }, { date: '2025-11-26 00:12', flow: 1 }]);
			const s = importApi(body, '', 'readings');
			expect(s.unitIn).toBe('cumec');
			expect(s.flow?.points).toHaveLength(2);
		});

		it('says when the rows are monthly', () => {
			const s = importApi(JSON.stringify(matrixRows), '', 'readings');
			expect(s.flow).toBeNull();
			expect(s.message?.text).toContain('monthly values only');
		});
	});

	describe('daily flow', () => {
		it('reads a day a row as m³/s, and counts days', () => {
			const body = JSON.stringify([{ date: '2025-10-01', flow: 2.5, quality: 1 }, { date: '2025-10-02', flow: null, quality: 170 }, { date: '2025-10-03', flow: 2.1, quality: 1 }]);
			const s = importApi(body, 'X0H001', 'daily');
			expect(s.unitIn).toBe('cumec');
			expect(s.flow?.points?.map((p) => p.v)).toEqual([2.5, null, 2.1]);
			expect(s.message).toEqual({ level: 'info', text: 'Read 2 days, 2025-10-01 to 2025-10-03.' });
		});

		it('counts one day as one day', () => {
			const body = JSON.stringify([{ time: '2025-10-01T00:00:00', flow: 2 }, { time: '2025-10-01T12:00:00', flow: 2 }]);
			expect(importApi(body, 'X0H001', 'daily').message?.text).toBe('Read 1 day, 2025-10-01 to 2025-10-01.');
		});

		it('refuses daily flow in Mm³, as real-time readings are', () => {
			const body = JSON.stringify([{ date: '2025-10-01', 'Flow Mm3': 1 }, { date: '2025-10-02', 'Flow Mm3': 1 }]);
			expect(importApi(body, '', 'daily').message).toEqual({ level: 'error', text: MM3_REFUSED });
		});
	});

	describe('monthly', () => {
		const dated = [{ date: '2000-10', flow: 1 }, { date: '2000-11', flow: 2 }, { date: '2000-12', flow: 3 }];

		it('reads date rows as Mm³ per month', () => {
			const s = importApi(JSON.stringify(dated), 'X0H001', 'monthly');
			expect(s.name).toBe('X0H001');
			expect(s.unitIn).toBe('mm3');
			expect(s.flow?.step).toBe('monthly');
			expect(s.flow?.records.map((r) => r.v)).toEqual([1, 2, 3]);
			expect(s.message).toEqual({ level: 'info', text: 'Read 3 months, Oct 2000 to Dec 2000. Layout: monthly date column.' });
		});

		it('reads a year and month matrix from JSON rows', () => {
			const s = importApi(JSON.stringify({ rows: matrixRows }), '', 'monthly');
			expect(s.sheet?.layout?.kind).toBe('matrix');
			expect(s.flow?.months).toBe(24);
			expect(s.flow?.first).toMatchObject({ y: 2000, m: 10, v: 1 });
			expect(s.message?.text).toBe('Read 24 months, Oct 2000 to Sep 2002. Layout: year rows by month columns.');
		});

		it('reads date rows and a matrix from CSV', () => {
			expect(importApi('Date,Flow\n2000-10,1\n2000-11,2\n', '', 'monthly').flow?.months).toBe(2);
			const csv = ['Year,' + MONTHS.join(','), '2000,1,2,3,4,5,6,7,8,9,10,11,12'].join('\n');
			expect(importApi(csv, '', 'monthly').flow?.months).toBe(12);
		});

		it('reads year and month keys in any order, with an unnamed value', () => {
			const body = JSON.stringify([{ month: 10, year: 2000, value: 1.5 }, { month: 11, year: 2000, value: 2.5 }]);
			const s = importApi(body, '', 'monthly');
			expect(s.flow?.records).toEqual([{ y: 2000, m: 10, v: 1.5 }, { y: 2000, m: 11, v: 2.5 }]);
		});

		it('takes up a unit the response names, and the control rebuilds in the other', () => {
			const s = importApi(JSON.stringify([{ date: '2000-10', 'Flow (m3/s)': 1 }, { date: '2000-11', 'Flow (m3/s)': 1 }]), '', 'monthly');
			expect(s.unitIn).toBe('cumec');
			expect(s.flow?.first?.v).toBeCloseTo(2.6784, 4);
			expect(applyImport({ ...s, unitIn: 'mm3' }, 'monthly').flow?.first?.v).toBe(1);
		});

		it('sends readings too short for a month to the other comparison', () => {
			const body = JSON.stringify([{ date: '2025-11-26 00:00', flow: 1 }, { date: '2025-11-26 00:12', flow: 1 }]);
			const s = importApi(body, '', 'monthly');
			expect(s.flow).toBeNull();
			expect(s.message?.text).toContain('Real Time Comparison');
		});
	});

	describe('a response that holds no flow', () => {
		const wants = ['readings', 'monthly'] as const;
		const problem = (body: string) => {
			const [a, b] = wants.map((want) => importApi(body, 'X0H001', want));
			for (const s of [a, b]) {
				expect(s.flow).toBeNull();
				expect(s.sheet).not.toBeNull();
				expect(s.message?.level).toBe('error');
			}
			expect(a.message).toEqual(b.message);
			return a.message?.text;
		};

		it.each([
			['[]', 'The API returned no rows.'],
			['{"data":[]}', 'The API returned no rows.'],
			['{"rows":[]}', 'The API returned no rows.'],
			['{"data":[],"message":"No data for X0H001"}', 'The API returned no rows. It said: No data for X0H001'],
			['', 'The API returned an empty response.'],
			['  \n', 'The API returned an empty response.']
		])('an empty result %j', (body, text) => {
			expect(problem(body)).toBe(text);
		});

		it.each([
			['{"error":"Station not found"}', 'The API reported an error: Station not found'],
			['{"error":{"code":400,"message":"Invalid query"}}', 'The API reported an error: Invalid query'],
			['{"errors":[{"detail":"Bad date"}]}', 'The API reported an error: Bad date'],
			['{"error":"Partly failed","data":[{"date":"2000-10","flow":1}]}', 'The API reported an error: Partly failed'],
			['{"message":"Rate limit exceeded"}', 'The API said: Rate limit exceeded'],
			['{"detail":"Not authorised"}', 'The API said: Not authorised']
		])('an error object %j', (body, text) => {
			expect(problem(body)).toBe(text);
		});

		it('ignores an empty error field beside good rows', () => {
			const body = JSON.stringify({ error: null, errors: [], message: 'OK', data: [{ date: '2000-10', flow: 1 }] });
			expect(importApi(body, '', 'monthly').flow?.months).toBe(1);
		});

		it('cuts a long message short', () => {
			expect(problem(JSON.stringify({ error: 'x'.repeat(5000) }))).toHaveLength('The API reported an error: '.length + 200);
		});

		it.each([
			['{"data":{"date":"2000-10"}}', 'The API response has no rows. Expected a JSON list, or one under "data" or "rows". Found: data.'],
			['{"station":"X0H001","count":0}', 'The API response has no rows. Expected a JSON list, or one under "data" or "rows". Found: station, count.'],
			['{}', 'The API response has no rows. Expected a JSON list, or one under "data" or "rows". Found: nothing.'],
			['[1,2,3]', 'The API returned a JSON list whose items are not rows.'],
			['[{"date":"2000-10","flow":1},null]', 'The API returned a JSON list whose items are not rows.']
		])('JSON of the wrong shape %j', (body, text) => {
			expect(problem(body)).toBe(text);
		});

		it('a body that is neither JSON rows nor CSV', () => {
			const noTable = 'The API response has no flow table. Expected JSON rows or CSV with a date and a flow, or a year with month columns.';
			expect(problem('Service\nunavailable')).toBe(`${noTable} It began: Service unavailable`);
			expect(problem('null')).toBe(`${noTable} It began: null`);
			expect(problem('[{"station":"X0H001"}]')).toBe(`${noTable} It began: [{"station":"X0H001"}]`);
			expect(problem('<!DOCTYPE html><html></html>')).toBe('The API returned HTML or XML, not JSON rows or CSV. It may be a login or error page.');
			expect(problem('<?xml version="1.0"?><flows/>')).toContain('HTML or XML');
		});

		it('a JSON body cut off part way', () => {
			expect(problem('[{"date":"2000-10","flow":1},{"da')).toContain('The API response looks like JSON but cannot be read: ');
		});

		it('a CSV with a header and no rows', () => {
			expect(problem('Date,Flow\n')).toBe('No flow values were found.');
		});

		it('JSON rows with no value in them', () => {
			expect(problem('[{"date":"2000-10","flow":null},{"date":"2000-11","flow":null}]')).toBe('No flow values were found.');
		});
	});

	it('reads JSON behind a byte order mark', () => {
		expect(importApi('﻿[{"date":"2000-10","flow":1}]', '', 'monthly').flow?.months).toBe(1);
	});

	it('reads CSV as a sheet', () => {
		const { sheet, problem } = apiSheet('Date,Flow\n2025-11-26 00:00,0.9\n2025-11-26 00:12,0.8\n');
		expect(problem).toBe('');
		expect(sheet.layout?.kind).toBe('series');
		expect(sheet.rows).toHaveLength(3);
	});

	it('reads a JSON list of lists', () => {
		expect(importApi('[["Date","Flow"],["2000-10",1],["2000-11",2]]', '', 'monthly').flow?.months).toBe(2);
	});

	it('words a failed request with what the server said', () => {
		expect(apiHttpFailure(500, '{"error":"Database down"}')).toBe('API request failed: HTTP 500. The API reported an error: Database down');
		expect(apiHttpFailure(404, '')).toBe('API request failed: HTTP 404. The API returned an empty response.');
		expect(apiHttpFailure(503, 'Date,Flow\n2000-10,1\n')).toBe('API request failed: HTTP 503.');
	});

	it('names cross-origin as a cause when the browser gives no detail', () => {
		expect(apiRequestFailure(new TypeError('Failed to fetch'), 'monthly')).toContain('Failed to fetch. The address may be wrong, the server down, or it may not allow cross-origin requests');
		expect(apiRequestFailure(new Error('Stopped'), 'monthly')).toBe('API request failed: Stopped.');
	});

	it('gives a whole record longer than 31 days of readings', () => {
		expect(apiTimeoutMs('readings')).toBe(60_000);
		expect(apiTimeoutMs('monthly')).toBe(180_000);
		expect(apiTimeoutMs('daily')).toBe(180_000);
	});

	it('says how long it waited when the real timeout signal fires', async () => {
		const signal = AbortSignal.timeout(1);
		await new Promise((done) => signal.addEventListener('abort', done));
		expect(apiRequestFailure(signal.reason, 'readings')).toBe('API request failed: no full response within 60 seconds. The server may be slow or not responding.');
		expect(apiRequestFailure(signal.reason, 'monthly')).toContain('within 180 seconds');
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
	const file = { name: 'X0H001.mon', text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

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
	const file = { name: 'X0H001.day', text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

	it('loads for the Real Time Comparison in m³/s, with missing days and codes kept', async () => {
		const slot = await importFile(file, 'instant');
		expect(slot.message?.text).toBe('Read 2 readings, 2003-01-01 to 2003-01-03.');
		expect(slot.flow?.points?.map((p) => [p.v, p.code])).toEqual([[1, '1'], [null, '170'], [3, '91']]);
	});
});

describe('a monthly table worked up from a daily file', () => {
	const row = (y: number, first: string) => `${y}${[first, ...Array.from({ length: 11 }, () => '1.000')].map((c) => c.padStart(9)).join('')}`;
	const text = ['File Name : x0h001.mon   (from daily file : x0h001.day, dated: )', 'Units     : M.m3', 'Year      Oct      Nov      Dec', row(2000, '3.890+'), row(2001, '2.000')].join('\r\n');
	const file = { name: 'X0H001.MON', text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };

	it('counts a patched + month, and reads the table by its own format', async () => {
		const slot = await importFile(file, 'monthly');
		const at = (y: number, m: number) => slot.flow!.records.find((r) => r.y === y && r.m === m)?.v;
		expect(at(2000, 10)).toBe(3.89);
		expect(at(2001, 10)).toBe(2);
		expect(slot.flow?.missing).toBe(0);
	});
});
