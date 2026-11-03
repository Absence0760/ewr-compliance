import { describe, expect, it } from 'vitest';
import { DAYS, dailyMeans, meanMonthly, toCumec } from '#lib/ewr/parsers.ts';
import { CODED_LABEL, countOf, dayRowsOf, defaultMonth, ecOptionLabel, flowKeys, gaugeName, histRows, histSeries, keyStr, lineSeries, loadedMonths, periodLabel, presetRange, rtLatest, rtRange, rtRows, rtSeries, strKey, yearGroups } from './compare.ts';
import type { EwrLines, EwrNode, Flow, FlowPoint, MonthRecord } from '#lib/ewr/types.ts';

const twelve = (v: number) => new Array(12).fill(v);
const lines: EwrLines = { ewr: twelve(10), drought: twelve(5), urgent: twelve(9) };
const DAY = 86400000;

function flow(records: MonthRecord[]): Flow {
	return { records, points: null, step: 'monthly', unit: 'mm3', first: records[0], last: records[records.length - 1], months: records.length, missing: 0 };
}

describe('period', () => {
	const f = flow(Array.from({ length: 30 * 12 }, (_, i) => ({ y: 1990 + Math.floor(i / 12), m: (i % 12) + 1, v: 1 })));
	const { first, last } = flowKeys(f);

	it('round-trips month input values', () => {
		expect(keyStr(strKey('2001-03'))).toBe('2001-03');
		expect(keyStr(strKey('2001-12'))).toBe('2001-12');
		expect(periodLabel(strKey('2001-03'), strKey('2002-12'))).toBe('Mar 2001 to Dec 2002');
	});

	it('presets end on the last month and never start before the record', () => {
		expect(presetRange(f, 'full', 0, 0)).toEqual({ from: first, to: last });
		expect(presetRange(f, '10', 0, 0)).toEqual({ from: last - 119, to: last });
		const short = flow(f.records.slice(0, 36));
		expect(presetRange(short, '20', 0, 0).from).toBe(first);
		expect(presetRange(f, 'custom', 5, 6)).toEqual({ from: 5, to: 6 });
	});
});

describe('daily flow on the chart', () => {
	const jan = (d: number) => Date.UTC(2003, 0, d);
	const days = [{ t: jan(1), mean: 1, n: 1, code: '1' }, { t: jan(2), mean: 2, n: 1, code: '91' }, { t: jan(4), mean: 4, n: 1, code: '2' }];
	const range: [number, number] = [jan(1), jan(5)];

	it('leaves a missing day as a gap, and draws coded days in a series of their own', () => {
		const [flow, coded] = rtSeries(null, days, null, range);
		expect(flow.x).toEqual([1, 2, 3, 4].map((d) => jan(d) + DAY / 2));
		expect(flow.y).toEqual([1, null, null, 4]);
		expect(coded.label).toBe(CODED_LABEL);
		expect(coded.color).not.toBe(flow.color);
		expect(coded.y).toEqual([null, 2, null, null]);
		expect(coded.markers).toBe(true);
	});

	it('has no coded series when no day has a code, and takes the label given', () => {
		const s = rtSeries(null, [days[0]], null, range, 'Daily mean flow, X0H001 × 0.5');
		expect(s.map((x) => x.label)).toEqual(['Daily mean flow, X0H001 × 0.5']);
	});

	it('lists every calendar day of a month, with the empty ones empty', () => {
		const rows = dayRowsOf(days, '2003-02');
		expect(rows).toHaveLength(28);
		expect(rows[0]).toEqual({ date: '2003-02-01', flow: null, readings: 0, code: '', coded: false });
		expect(dayRowsOf(days, '2003-01')[1]).toEqual({ date: '2003-01-02', flow: 2, readings: 1, code: '91', coded: true });
	});

	it('counts in the singular for one', () => {
		expect(countOf(1, 'day')).toBe('1 day');
		expect(countOf(2, 'day')).toBe('2 days');
	});

	it('groups months by year, newest first', () => {
		expect(yearGroups(['2024-12', '2025-01', '2025-02'])).toEqual([
			{ year: '2025', months: ['2025-02', '2025-01'] },
			{ year: '2024', months: ['2024-12'] }
		]);
	});

	it('opens on the latest month with most of its days, or the latest there is', () => {
		const run = (y: number, m: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(y, m, i + 1), mean: 1, n: 1 }));
		expect(defaultMonth([...run(2025, 10, 16), ...run(2025, 11, 2)])).toBe('2025-11');
		expect(defaultMonth(run(2025, 11, 2))).toBe('2025-12');
		expect(defaultMonth([])).toBe('');
	});
});

describe('real time in the EWR\'s units', () => {
	const at = (d: number) => Date.UTC(2025, 10, d);
	const ewr: EwrLines = { ewr: twelve(1.7), drought: twelve(0.5), urgent: twelve(1.53) };
	// Nov has 30 days: 1 m³/s for a month is 2.592 Mm³.
	const days = [{ t: at(1), mean: 1, n: 1 }, { t: at(2), mean: 0.1, n: 1 }];

	it('shows the monthly lines as the EWR states them, and each day as the month at that flow', () => {
		const [flow, line] = rtSeries(ewr, days, [{ t: at(1), v: 1 }], [at(1), at(3)], 'Daily mean flow', 'mm3');
		expect(flow.y[0]).toBeCloseTo(2.592, 9);
		expect(line.y[0]).toBe(1.7);
		const raw = rtSeries(null, days, [{ t: at(1), v: 2 }, { t: at(1) + 1, v: null }], [at(1), at(3)], 'x', 'mm3').at(-1)!;
		expect(raw.y).toEqual([5.184, null]);
	});

	it('keeps status and counts the same in either unit, and only the figures change', () => {
		const [c] = rtRows(ewr, days);
		const [m] = rtRows(ewr, days, 'mm3');
		expect([m.status, m.daysEwr, m.daysDrought, m.days]).toEqual([c.status, c.daysEwr, c.daysDrought, c.days]);
		expect(m.ewr).toBe(1.7);
		expect(m.urgent).toBe(1.53);
		expect(m.drought).toBe(0.5);
		expect(m.mean).toBeCloseTo(0.55 * 2.592, 9);
	});

	it('uses the EWR\'s 28-day February, so a leap year keeps a flow on the same side of a line', () => {
		const feb = Date.UTC(2024, 1, 10);
		const [flow] = rtSeries(null, [{ t: feb, mean: 1, n: 1 }], null, [feb, feb + DAY], 'x', 'mm3');
		expect(flow.y[0]).toBeCloseTo(2.4192, 9);
	});

	it('gives the latest reading and day rows in the unit, and % of EWR either way', () => {
		const pts: FlowPoint[] = [{ t: at(1), v: 1 }];
		const l = rtLatest(ewr, pts, 'mm3')!;
		expect(l.v).toBeCloseTo(2.592, 9);
		expect(l.ewr).toBe(1.7);
		expect(l.pct).toBeCloseTo(rtLatest(ewr, pts)!.pct!, 9);
		expect(dayRowsOf(days, '2025-11', 'mm3')[0].flow).toBeCloseTo(2.592, 9);
	});
});

describe('gauge name', () => {
	it('shows a factor only when one is applied', () => {
		expect(gaugeName('X0H001', 1)).toBe('X0H001');
		expect(gaugeName('X0H001', 0.85)).toBe('X0H001 × 0.85');
	});
});

describe('chart series', () => {
	it('uses the exact line names', () => {
		expect(lineSeries(lines, 'cumec').map((s) => s.label)).toEqual(['EWR Monthly Requirement', 'Urgent action required', 'Drought EWR']);
		expect(lineSeries(lines, 'cumec')[1].dash).toBeTruthy();
		expect(lineSeries(null, 'cumec')).toEqual([]);
	});

	it('gives each month a full-width step and converts by month length', () => {
		const [ewr] = lineSeries(lines, 'cumec');
		expect(ewr.stepped).toBe(true);
		expect(ewr.x).toHaveLength(13);
		expect(ewr.x[0]).toBe(-0.5);
		expect(ewr.x[12]).toBe(11.5);
		expect(ewr.y[1]).toBeCloseTo(toCumec(10, 1) as number, 9);
		expect(ewr.y[12]).toBe(ewr.y[11]);
		expect(lineSeries(lines, 'mm3')[0].y[1]).toBe(10);
	});

	it('draws the selected period with markers and the full record grey and dashed', () => {
		const m = meanMonthly([{ y: 2000, m: 10, v: 3 }], 0, 1e9);
		const [sel, full] = histSeries(lines, 'mm3', m, m, 'Oct 2000 to Oct 2000');
		expect(sel.markers).toBe(true);
		expect(sel.dash).toBeUndefined();
		expect(sel.y[0]).toBe(3);
		expect(sel.y[1]).toBeNull();
		expect(full.label).toBe('Observed, full record');
		expect(full.color).toBe('#52514e');
		expect(full.dash).toBeTruthy();
	});

	it('steps real time lines on the first of the month, inside the span', () => {
		const t0 = Date.UTC(2025, 10, 20), t1 = Date.UTC(2025, 11, 5);
		const [, ewr, urgent, drought] = rtSeries(lines, [{ t: t0, mean: 1, n: 1 }], null, [t0, t1]);
		expect(ewr.x).toEqual([t0, Date.UTC(2025, 11, 1), t1]);
		expect(ewr.y[0]).toBeCloseTo(10e6 / (DAYS[1] * 86400), 9);
		expect(ewr.y[1]).toBeCloseTo(10e6 / (DAYS[2] * 86400), 9);
		expect(urgent.label).toBe('Urgent action required');
		expect(urgent.y[0]).toBeCloseTo(9e6 / (DAYS[1] * 86400), 9);
		expect(drought.label).toBe('Drought EWR');
	});

	it('hides markers on long daily series and adds raw readings last', () => {
		const days = Array.from({ length: 70 }, (_, i) => ({ t: i * DAY, mean: 1, n: 1 }));
		const raw: FlowPoint[] = [{ t: 0, v: 1 }];
		const s = rtSeries(null, days, raw, rtRange(days, 'all'));
		expect(s[0].markers).toBe(false);
		expect(s[0].x[0]).toBe(DAY / 2);
		expect(s[1].label).toBe('12-minute readings');
	});

	it('spans a chosen month from first to last day', () => {
		expect(rtRange([], '2025-12')).toEqual([Date.UTC(2025, 11, 1), Date.UTC(2026, 0, 1)]);
	});
});

describe('histRows', () => {
	const selected = meanMonthly(
		[{ y: 2000, m: 10, v: 12 }, { y: 2001, m: 10, v: 6 }, { y: 2000, m: 11, v: 9.5 }, { y: 2000, m: 12, v: 8.5 }, { y: 2001, m: 12, v: 8 }],
		0, 1e9
	);

	it('computes on Mm³ whatever the display unit', () => {
		const a = histRows(lines, selected, 'mm3')[0], b = histRows(lines, selected, 'cumec')[0];
		expect(a.mean).toBe(9);
		expect(a.pct).toBe(90);
		expect(a.met).toBe(50);
		expect(a.metDrought).toBe(100);
		expect(a.years).toBe(2);
		expect(b.mean).toBe(9);
		expect(b.pct).toBe(90);
		expect(b.meanInUnit).toBeCloseTo(toCumec(9, 0) as number, 9);
		expect(b.ewr).toBeCloseTo(toCumec(10, 0) as number, 9);
		expect(b.status).toEqual(a.status);
	});

	it('uses monthStatus for the mean, and No data for an empty month', () => {
		const rows = histRows(lines, selected, 'mm3');
		expect(rows[1].status?.key).toBe('warning');
		expect(rows[2].status?.key).toBe('serious');
		expect(rows[3].status).toEqual({ key: 'none', label: 'No data' });
		expect(rows[3].pct).toBeNull();
	});

	it('has only the lines before any flow is loaded', () => {
		const r = histRows(lines, null, 'mm3')[0];
		expect(r.ewr).toBe(10);
		expect(r.urgent).toBe(9);
		expect(r.status).toBeNull();
	});
});

describe('real time', () => {
	const at = (d: number, h: number) => Date.UTC(2025, 10, d, h);
	// Nov EWR 1.7 Mm³ is 0.6559 m³/s, Urgent 0.5903; the second day is the one below them.
	const lines: EwrLines = { ewr: twelve(1.7), drought: twelve(0.5), urgent: twelve(1.53) };
	const pts: FlowPoint[] = [{ t: at(1, 0), v: 0.7 }, { t: at(1, 12), v: 0.9 }, { t: at(2, 0), v: 0.1 }, { t: at(2, 12), v: null }];

	it('compares daily means with the line in m³/s', () => {
		const [r] = rtRows(lines, dailyMeans(pts));
		expect(r.label).toBe('Nov 2025');
		expect(r.days).toBe(2);
		expect(r.mean).toBeCloseTo(0.45, 9);
		expect(r.ewr).toBeCloseTo(0.6559, 4);
		expect(r.daysEwr).toBe(1);
		expect(r.daysDrought).toBe(1);
		expect(r.urgent).toBeCloseTo(0.59, 3);
		expect(r.status.key).toBe('serious');
	});

	it('lists the months loaded', () => {
		expect(loadedMonths([{ t: at(30, 0), mean: 1, n: 1 }, { t: at(31, 0), mean: 1, n: 1 }])).toEqual(['2025-11', '2025-12']);
	});

	it('reads the latest reading against that month', () => {
		const l = rtLatest(lines, pts.slice(0, 3));
		expect(l?.v).toBe(0.1);
		expect(l?.month).toBe('Nov');
		expect(l?.pct).toBeCloseTo((100 * 0.1) / (toCumec(1.7, 1) as number), 9);
		expect(rtLatest(null, pts.slice(0, 3))?.ewr).toBeNull();
		expect(rtLatest(lines, [])).toBeNull();
	});
});

describe('ecOptionLabel', () => {
	const n = { tec: 'C', tecInc: 'B', rec: 'C', pes: 'D' } as EwrNode;

	it('says which category an EC is', () => {
		expect(ecOptionLabel(n, 'C', '')).toBe('C (TEC, REC)');
		expect(ecOptionLabel(n, 'D', '')).toBe('D (PES)');
		expect(ecOptionLabel(n, 'A', '')).toBe('A');
	});

	it('uses the incremental TEC on the incremental basis', () => {
		expect(ecOptionLabel(n, 'B', 'inc')).toBe('B (TEC)');
		expect(ecOptionLabel(n, 'C', 'inc')).toBe('C (REC)');
	});
});
