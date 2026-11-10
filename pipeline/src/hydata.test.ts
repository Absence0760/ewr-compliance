import { describe, expect, it } from 'vitest';
import { isDay, parseDay } from '../../src/lib/ewr/parsers.ts';
import { DwsFormatError, DwsServerError } from './errors.ts';
import { dayLine, dwsUrl, lineRow, readPage, renderDay } from './hydata.ts';
import { fixture, page, row } from './testing.ts';

const Q1 = { from: '2010-01-01', to: '2010-03-31' };

describe('dwsUrl', () => {
	it('asks HyData.aspx for one river gauge, daily, in the window', () => {
		const u = new URL(dwsUrl('X0H001', '2010-01-01', '2010-03-31'));
		expect(u.origin + u.pathname).toBe('https://www.dws.gov.za/Hydrology/Verified/HyData.aspx');
		expect(Object.fromEntries(u.searchParams)).toEqual({ Station: 'X0H001100.00', DataType: 'Daily', StartDT: '2010-01-01', EndDT: '2010-03-31', SiteType: 'RIV' });
	});

	it('refuses anything that is not a river gauge code', () => {
		for (const s of ['X0R001', 'x0h001', 'X0H01', 'X0H001&DataType=Point']) expect(() => dwsUrl(s, '2010-01-01', '2010-01-02')).toThrow(RangeError);
	});
});

describe('readPage', () => {
	it('reads the synthetic reply: one row a listed day, a gap row and codes as written', () => {
		const p = readPage(fixture('X0H001-reply.synthetic.html'), Q1);
		// 90 days in the quarter, less 2010-02-10, which has no row.
		expect(p.rows).toHaveLength(89);
		expect(p.rows.find((r) => r.day === '20100210')).toBeUndefined();
		expect(p.rows.find((r) => r.day === '20100220')).toEqual({ day: '20100220', flow: '', code: '170' });
		expect(p.rows.find((r) => r.day === '20100305')).toEqual({ day: '20100305', flow: '2.420', code: '50' });
		expect(p.rows[0]).toEqual({ day: '20100101', flow: '1.500', code: '1' });
		expect(p.rows.at(-1)?.day).toBe('20100331');
	});

	it('writes a -999 placeholder blank, and counts it', () => {
		const p = readPage(fixture('X0H001-reply.synthetic.html'), Q1);
		expect(p.rows.find((r) => r.day === '20100312')).toEqual({ day: '20100312', flow: '', code: '152' });
		expect(p.blanked).toBe(1);
	});

	it('drops rows dated outside the window asked for', () => {
		const p = readPage(fixture('X0H001-reply.synthetic.html'), { from: '2010-02-01', to: '2010-02-28' });
		expect(p.rows.map((r) => r.day)).toEqual(expect.arrayContaining(['20100201', '20100228']));
		expect(p.rows.every((r) => r.day >= '20100201' && r.day <= '20100228')).toBe(true);
		expect(p.outside).toBe(89 - p.rows.length);
	});

	it('takes the ScriptServer page for DWS failing, not for a changed layout', () => {
		expect(() => readPage(fixture('X0H001-scriptserver.synthetic.html'), Q1)).toThrow(DwsServerError);
	});

	it('reads "No data for this period" as no rows', () => {
		expect(readPage(fixture('X0H001-nodata.synthetic.html'), Q1)).toEqual({ rows: [], outside: 0, blanked: 0 });
	});

	it('strips every tag inside the table, nested ones included', () => {
		const raw = page('X0H001', [`<b><i>20100102</i></b>${'1.000'.padStart(10)}<span>     1</span>`]);
		expect(readPage(raw, Q1).rows).toEqual([{ day: '20100102', flow: '1.000', code: '1' }]);
	});

	it('drops the < of a tag left unclosed', () => {
		const raw = page('X0H001', [row('2010-01-02', '1.000', '1') + '<script']);
		expect(readPage(raw, Q1).rows).toEqual([{ day: '20100102', flow: '1.000', code: '1' }]);
	});

	it('ignores a <pre> inside an HTML comment', () => {
		const raw = `<!-- <pre>DATE     D AVG F/R  QUAL\n20100101     9.000     1</pre> -->\n${page('X0H001', [row('2010-01-02', '1.000', '1')])}`;
		expect(readPage(raw, Q1).rows.map((r) => r.day)).toEqual(['20100102']);
	});

	it.each([
		['no table at all', '<html><body>Something else</body></html>', 'no data table'],
		['a page with no DATE header', '<p><pre>POS. 1-8 = Date\n20100101     1.000     1</pre>', 'no DATE header'],
		['different columns', page('X0H001', [row('2010-01-01', '1.000', '1')]).replace('DATE     D AVG F/R  QUAL', 'DATE     LEVEL  QUAL'), 'columns changed'],
		['a flow in another unit', page('X0H001', [row('2010-01-01', '1.000', '1')]).replace('cubic metres/sec', 'megalitres/day'), 'not a flow in m3/s'],
		['an impossible date', page('X0H001', [row('2010-02-30', '1.000', '1')]), 'impossible date'],
		['a day listed twice', page('X0H001', [row('2010-01-01', '1.000', '1'), row('2010-01-01', '2.000', '1')]), 'a day listed twice'],
		['a flow above 100 000 m³/s', page('X0H001', [row('2010-01-01', '100001.0', '1')]), 'flow out of range'],
		['a code too wide for its column', page('X0H001', ['20100101     1.000  ABCDEF']), 'bad quality code'],
		['a row with four fields', page('X0H001', [`${row('2010-01-01', '1.000', '1')}  X`]), 'columns changed']
	])('refuses %s, with a fixed label for the log', (_, raw, label) => {
		const err = (() => {
			try {
				readPage(raw, Q1);
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(DwsFormatError);
		expect((err as DwsFormatError).label).toBe(label);
		// The message never quotes the page.
		expect((err as Error).message).not.toMatch(/X0H001|2010/);
	});

	it('writes text in the flow column blank, as a missing day', () => {
		const p = readPage(page('X0H001', [`20100101   Missing     1`]), Q1);
		expect(p.rows).toEqual([{ day: '20100101', flow: '', code: '1' }]);
		expect(p.blanked).toBe(1);
	});
});

describe('renderDay', () => {
	const rows = readPage(fixture('X0H001-reply.synthetic.html'), Q1).rows;

	it("writes EWR's .day layout, which EWR's own parseDay reads back day for day", () => {
		const text = renderDay('X0H001', rows);
		expect(isDay(text)).toBe(true);
		const points = parseDay(text);
		expect(points).toHaveLength(rows.length);
		const at = (d: string) => points.find((p) => p.t === Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
		expect(at('2010-01-01')).toEqual({ t: Date.UTC(2010, 0, 1), v: 1.5, code: '1' });
		// Code 170 and a blank flow are a missing day; any other code is a value the app draws in its own colour.
		expect(at('2010-02-20')).toMatchObject({ v: null, code: '170' });
		expect(at('2010-03-05')).toMatchObject({ v: 2.42, code: '50' });
		expect(at('2010-03-12')).toMatchObject({ v: null, code: '152' });
		expect(at('2010-02-10')).toBeUndefined();
	});

	it('puts each column where the format block says: date 1-8, flow 10-18, code 20-24', () => {
		expect(dayLine({ day: '20100101', flow: '1.500', code: '1' })).toBe('20100101     1.500     1');
		expect(dayLine({ day: '20100220', flow: '', code: '170' })).toBe('20100220             170');
		expect(dayLine({ day: '20100101', flow: '99999.999', code: 'ABCDE' })).toBe('20100101 99999.999 ABCDE');
		expect(lineRow('20100220             170')).toEqual({ day: '20100220', flow: '', code: '170' });
		expect(lineRow('DATE     D AVG F/R  QUAL')).toBeNull();
	});

	it('round-trips through lineRow, so a merge never changes a stored day', () => {
		const text = renderDay('X0H001', rows);
		expect(text.split('\n').map(lineRow).filter(Boolean)).toEqual(rows);
	});
});
