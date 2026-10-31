import { describe, expect, it } from 'vitest';
import { DAYS, dailyMeans, meanMonthly, toCumec } from '#lib/ewr/parsers.ts';
import { ecOptionLabel, flowKeys, histRows, histSeries, keyStr, lineSeries, loadedMonths, periodLabel, presetRange, rtLatest, rtRange, rtRows, rtSeries, strKey } from './compare.ts';
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
