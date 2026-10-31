// The chart's pure parts: its series shape, axis ticks and the crosshair readout.

export interface ChartSeries {
	label: string;
	color: string;
	/** Ascending. Each series keeps its own x, so a monthly step and daily flow can share a chart. */
	x: number[];
	/** null is a gap in the line. */
	y: (number | null)[];
	dash?: number[];
	/** Draw a marker on every point. Leave off for dense series. */
	markers?: boolean;
	/** Each y holds until the next x. */
	stepped?: boolean;
	width?: number;
	/** How far from a point the readout still reports it, in x units. */
	reach?: number;
}

export type ChartAxis = 'month' | 'time';

const DAY = 86400000;
const HOUR = 3600000;
const TIME_STEPS = [1, 3, 6, 12].map((h) => h * HOUR).concat([1, 2, 7, 14, 30, 91, 365].map((d) => d * DAY));

/** The smallest tick step that leaves `px` pixels per label over `width`. */
export function timeStep(span: number, width: number, px = 52): number {
	const room = Math.max(1, Math.floor(width / px));
	return TIME_STEPS.find((s) => span / s <= room) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/** Ticks counted from the record's start, so a month view reads 1, 2, 3 from its first day. */
export function timeTicks(origin: number, min: number, max: number, step: number): number[] {
	const out: number[] = [];
	for (let t = origin + Math.ceil((min - origin) / step) * step; t <= max; t += step) out.push(t);
	return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function timeTick(t: number, step: number, daysOnly: boolean): string {
	const d = new Date(t);
	if (step < DAY) return d.toISOString().slice(11, 16);
	return daysOnly ? String(d.getUTCDate()) : `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export const timeReadout = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** Index of the last x at or before v, or -1. */
function lastAtOrBefore(xs: number[], v: number): number {
	let lo = 0, hi = xs.length - 1, out = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= v) {
			out = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return out;
}

/** A series' value at the crosshair: the step in force, or the nearest point within reach. */
export function valueAt(s: Pick<ChartSeries, 'x' | 'y' | 'stepped' | 'reach'>, v: number): number | null {
	const n = s.x.length;
	if (!n) return null;
	const i = lastAtOrBefore(s.x, v);
	if (s.stepped) return s.y[Math.max(i, 0)];
	const j = i < 0 ? 0 : i === n - 1 ? i : v - s.x[i] <= s.x[i + 1] - v ? i : i + 1;
	return Math.abs(s.x[j] - v) <= (s.reach ?? Infinity) ? s.y[j] : null;
}

/** What a screen reader hears for the canvas. The table below the chart holds the values. */
export function chartSummary(title: string, xLabel: string, yLabel: string, series: Pick<ChartSeries, 'label'>[], span: string): string {
	const shows = series.length ? `Shows ${series.map((s) => s.label).join(', ')}` : 'No data yet';
	return `${title}. ${shows}. ${yLabel} against ${xLabel}${span ? `, ${span}` : ''}.`;
}
