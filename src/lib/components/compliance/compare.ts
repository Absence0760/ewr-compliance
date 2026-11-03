// Table rows and chart series for the two comparisons, so the components only render.
// Conversion and status all come from src/lib/ewr.
import { CALENDAR, SERIES } from '#lib/ewr/format.ts';
import { MONTHS, isCoded, monthIndex, monthStatus, shareAtLeast, toCumec, toMm3, ymKey } from '#lib/ewr/parsers.ts';
import type { ChartSeries } from '#lib/components/charts/chart.ts';
import type { DayMean, EwrLines, EwrNode, Flow, FlowBasis, FlowPoint, FlowUnit, MonthMean, MonthState, PeriodPreset } from '#lib/ewr/types.ts';

const DAY = 86400000;

export const tecOf = (n: EwrNode, basis: FlowBasis) => (basis === 'inc' ? n.tecInc || n.tec : n.tec);

export function ecOptionLabel(n: EwrNode, ec: string, basis: FlowBasis): string {
	const tags = [['TEC', tecOf(n, basis)], ['REC', n.rec], ['PES', n.pes]].filter(([, v]) => v === ec).map(([k]) => k);
	return tags.length ? `${ec} (${tags.join(', ')})` : ec;
}

export const unitName = (unit: FlowUnit) => (unit === 'cumec' ? 'm³/s' : 'Mm³');
export const unitTitle = (unit: FlowUnit) => (unit === 'cumec' ? 'Discharge (m³/s)' : 'Volume (Mm³ per month)');

const inUnit = (v: number | null, i: number, unit: FlowUnit) => (unit === 'cumec' ? toCumec(v, i) : v);

/**
 * A flow in m³/s in the unit shown at a time. Mm³ is the month's volume at that flow, by the same
 * days as the EWR's conversion, so a flow and a line keep their order in either unit.
 */
const flowInUnit = (v: number, t: number, unit: FlowUnit) => (unit === 'cumec' ? v : (toMm3(v, monthIndex(new Date(t).getUTCMonth() + 1)) as number));

// ---- period -------------------------------------------------------------------

export const keyStr = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
export function strKey(s: string): number {
	const [y, m] = s.split('-').map(Number);
	return ymKey(y, m);
}

export function periodLabel(from: number, to: number): string {
	const f = (k: number) => `${CALENDAR[(k % 12) + 1]} ${Math.floor(k / 12)}`;
	return `${f(from)} to ${f(to)}`;
}

/** The station, with its factor when one is applied, as the chart names the record. */
export const gaugeName = (station: string, factor: number) => (factor === 1 ? station : `${station} × ${factor}`);

export const flowKeys = (f: Flow) => ({ first: ymKey(f.first!.y, f.first!.m), last: ymKey(f.last!.y, f.last!.m) });

/** The from and to a preset gives. A custom period stays as it is. */
export function presetRange(f: Flow, preset: PeriodPreset, from: number, to: number): { from: number; to: number } {
	const { first, last } = flowKeys(f);
	if (preset === 'full') return { from: first, to: last };
	if (preset === '10' || preset === '20') return { from: Math.max(first, last - Number(preset) * 12 + 1), to: last };
	return { from, to };
}

// ---- chart series -------------------------------------------------------------

// Month i is centred on x = i, so a step spans i - 0.5 to i + 0.5 and every month is full width.
const MONTH_EDGES = [...MONTHS.map((_, i) => i - 0.5), 11.5];
const MONTH_CENTRES = MONTHS.map((_, i) => i);
export const MONTH_RANGE: [number, number] = [-0.5, 11.5];

const monthStep = (label: string, values: (number | null)[], color: string, dash?: number[]): ChartSeries => ({
	label, color, dash, stepped: true, x: MONTH_EDGES, y: [...values, values[11]]
});

const inUnits = (values: (number | null)[], unit: FlowUnit) => values.map((v, i) => inUnit(v, i, unit));

export function lineSeries(lines: EwrLines | null, unit: FlowUnit): ChartSeries[] {
	if (!lines) return [];
	const out = [monthStep('EWR Monthly Requirement', inUnits(lines.ewr, unit), SERIES.ewr)];
	out.push(monthStep('Urgent action required', inUnits(lines.urgent, unit), SERIES.urgent, [6, 4]));
	out.push(monthStep('Drought EWR', inUnits(lines.drought, unit), SERIES.drought));
	return out;
}

const meanSeries = (label: string, m: MonthMean[], unit: FlowUnit, color: string, dash?: number[]): ChartSeries => ({
	label, color, dash, markers: true, reach: 0.5, x: MONTH_CENTRES, y: inUnits(m.map((x) => x.mean), unit)
});

/** Selected period first, then the full record when it differs, then the EWR lines. */
export function histSeries(lines: EwrLines | null, unit: FlowUnit, selected: MonthMean[] | null, full: MonthMean[] | null, label: string): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (selected) out.push(meanSeries(`Observed, ${label}`, selected, unit, SERIES.flow));
	if (full) out.push(meanSeries('Observed, full record', full, unit, SERIES.full, [4, 3]));
	return [...out, ...lineSeries(lines, unit)];
}

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
export const monthName = (m: string) => `${CALENDAR[Number(m.slice(5))]} ${m.slice(0, 4)}`;
const monthFloor = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
const monthNext = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);

/** The span drawn: the days loaded, or a whole calendar month. */
export function rtRange(days: DayMean[], month: string): [number, number] {
	if (month !== 'all') {
		const start = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1);
		return [start, monthNext(start)];
	}
	return [days[0].t, days[days.length - 1].t + DAY];
}

/** A monthly line over time, stepping on the first of each month. */
function timeStep(values: number[], t0: number, t1: number, label: string, color: string, dash: number[] | undefined, unit: FlowUnit): ChartSeries {
	const x: number[] = [], y: number[] = [];
	for (let m = monthFloor(t0); m < t1; m = monthNext(m)) {
		const i = monthIndex(new Date(m).getUTCMonth() + 1);
		x.push(Math.max(m, t0));
		y.push(inUnit(values[i], i, unit) as number);
	}
	return { label, color, dash, stepped: true, x: [...x, t1], y: [...y, y[y.length - 1]] };
}

/** A value for each day of the span, so a day with no flow is a gap in the line and not a join. */
function dayValues(days: DayMean[], t0: number, t1: number, unit: FlowUnit, keep: (d: DayMean) => boolean) {
	const byDay = new Map(days.map((d) => [d.t, d]));
	const x: number[] = [], y: (number | null)[] = [];
	for (let t = Math.floor(t0 / DAY) * DAY; t < t1; t += DAY) {
		const d = byDay.get(t);
		x.push(t + DAY / 2);
		y.push(d && keep(d) ? flowInUnit(d.mean, t, unit) : null);
	}
	return { x, y };
}

export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export const CODED_LABEL = 'Patched or unreliable (quality code)';

/** Days with a quality code get a line and colour of their own, drawn only when a day has one. */
export function rtSeries(lines: EwrLines | null, days: DayMean[], raw: FlowPoint[] | null, [t0, t1]: [number, number], label = 'Daily mean flow', unit: FlowUnit = 'cumec'): ChartSeries[] {
	const out: ChartSeries[] = [{
		label, color: SERIES.flow, markers: days.length <= 62, reach: DAY, ...dayValues(days, t0, t1, unit, (d) => !isCoded(d.code))
	}];
	if (days.some((d) => isCoded(d.code))) {
		out.push({ label: CODED_LABEL, color: SERIES.coded, dash: [2, 3], markers: true, reach: DAY, ...dayValues(days, t0, t1, unit, (d) => isCoded(d.code)) });
	}
	if (lines) {
		out.push(timeStep(lines.ewr, t0, t1, 'EWR Monthly Requirement', SERIES.ewr, undefined, unit));
		out.push(timeStep(lines.urgent, t0, t1, 'Urgent action required', SERIES.urgent, [6, 4], unit));
		out.push(timeStep(lines.drought, t0, t1, 'Drought EWR', SERIES.drought, undefined, unit));
	}
	if (raw) out.push({ label: '12-minute readings', color: SERIES.raw, width: 1, reach: 3600000, x: raw.map((p) => p.t), y: raw.map((p) => (p.v === null ? null : flowInUnit(p.v, p.t, unit))) });
	return out;
}

// ---- tables -------------------------------------------------------------------

export interface HistRow {
	month: string;
	ewr: number | null;
	urgent: number | null;
	drought: number | null;
	mean: number | null;
	meanInUnit: number | null;
	pct: number | null;
	met: number | null;
	metDrought: number | null;
	years: number | null;
	status: MonthState | null;
}

/** Status and the shares compare Mm³ with Mm³; the unit only changes what is shown. */
export function histRows(lines: EwrLines, selected: MonthMean[] | null, unit: FlowUnit): HistRow[] {
	return MONTHS.map((month, i) => {
		const s = selected?.[i];
		return {
			month,
			ewr: inUnit(lines.ewr[i], i, unit),
			urgent: inUnit(lines.urgent[i], i, unit),
			drought: inUnit(lines.drought[i], i, unit),
			mean: s ? s.mean : null,
			meanInUnit: s ? inUnit(s.mean, i, unit) : null,
			pct: s?.mean != null && lines.ewr[i] > 0 ? (100 * s.mean) / lines.ewr[i] : null,
			met: s ? shareAtLeast(s.values, lines.ewr[i]) : null,
			metDrought: s ? shareAtLeast(s.values, lines.drought[i]) : null,
			years: s ? s.n : null,
			status: s ? monthStatus(s.mean, lines, i) : null
		};
	});
}

// ---- months and days of a gauge -----------------------------------------------

/** Months as pull-down groups, newest year first. */
export function yearGroups(months: string[]): { year: string; months: string[] }[] {
	const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
	return years.map((year) => ({ year, months: months.filter((m) => m.startsWith(year)).sort().reverse() }));
}

const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();

/** The latest month with most of its days measured, or the latest of all when none has. */
export function defaultMonth(days: DayMean[]): string {
	const months = loadedMonths(days);
	const count = (m: string) => days.filter((d) => monthOf(d.t) === m).length;
	return months.findLast((m) => count(m) * 2 > daysInMonth(m)) ?? months[months.length - 1] ?? '';
}

export interface DayRow {
	date: string;
	flow: number | null;
	readings: number;
	code: string;
	coded: boolean;
}

/** One row a calendar day: a day with no flow stays in the list, empty. */
export function dayRowsOf(days: DayMean[], month: string, unit: FlowUnit = 'cumec'): DayRow[] {
	const start = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1);
	const byDay = new Map(days.map((d) => [d.t, d]));
	return Array.from({ length: daysInMonth(month) }, (_, i) => {
		const t = start + i * DAY;
		const d = byDay.get(t);
		return { date: new Date(t).toISOString().slice(0, 10), flow: d ? flowInUnit(d.mean, t, unit) : null, readings: d?.n ?? 0, code: d?.code ?? '', coded: isCoded(d?.code) };
	});
}

export interface RtRow {
	label: string;
	days: number;
	mean: number;
	ewr: number;
	urgent: number;
	drought: number;
	daysEwr: number;
	daysDrought: number;
	status: MonthState;
}

export const loadedMonths = (daily: DayMean[]) => [...new Set(daily.map((d) => monthOf(d.t)))];

/** Compared in m³/s, daily flow against the converted lines; the unit only changes what is shown. */
export function rtRows(lines: EwrLines, daily: DayMean[], unit: FlowUnit = 'cumec'): RtRow[] {
	const cumec = (arr: number[]) => arr.map((v, i) => toCumec(v, i) as number);
	const c = { ewr: cumec(lines.ewr), urgent: cumec(lines.urgent), drought: cumec(lines.drought) };
	return loadedMonths(daily).map((m) => {
		const ds = daily.filter((d) => monthOf(d.t) === m);
		const i = monthIndex(Number(m.slice(5)));
		const mean = ds.reduce((a, d) => a + d.mean, 0) / ds.length;
		return {
			label: monthName(m), days: ds.length, mean: flowInUnit(mean, ds[0].t, unit),
			ewr: inUnit(lines.ewr[i], i, unit) as number, urgent: inUnit(lines.urgent[i], i, unit) as number, drought: inUnit(lines.drought[i], i, unit) as number,
			daysEwr: ds.filter((d) => d.mean >= c.ewr[i]).length,
			daysDrought: ds.filter((d) => d.mean >= c.drought[i]).length,
			status: monthStatus(mean, c, i)
		};
	});
}

export interface RtLatest {
	t: number;
	v: number;
	month: string;
	ewr: number | null;
	pct: number | null;
}

export function rtLatest(lines: EwrLines | null, pts: FlowPoint[], unit: FlowUnit = 'cumec'): RtLatest | null {
	const last = pts[pts.length - 1];
	if (!last || last.v === null) return null;
	const i = monthIndex(new Date(last.t).getUTCMonth() + 1);
	const ewr = lines ? toCumec(lines.ewr[i], i) : null;
	return {
		t: last.t, v: flowInUnit(last.v, last.t, unit), month: MONTHS[i], ewr: lines ? inUnit(lines.ewr[i], i, unit) : null,
		pct: ewr !== null && ewr > 0 ? (100 * last.v) / ewr : null
	};
}

