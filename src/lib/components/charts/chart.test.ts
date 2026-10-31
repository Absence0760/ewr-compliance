import { describe, expect, it } from 'vitest';
import { chartSummary, timeReadout, timeStep, timeTick, timeTicks, valueAt } from './chart.ts';

const DAY = 86400000;

describe('valueAt', () => {
	const step = { x: [-0.5, 0.5, 1.5, 2.5], y: [1, 2, 3, 3], stepped: true };

	it('a step holds across its whole month', () => {
		expect(valueAt(step, -0.5)).toBe(1);
		expect(valueAt(step, 0.49)).toBe(1);
		expect(valueAt(step, 0.5)).toBe(2);
		expect(valueAt(step, 2.4)).toBe(3);
	});

	it('takes the nearest point, and no further than its reach', () => {
		const flow = { x: [0, 10, 100], y: [1, 2, 3], reach: 6 };
		expect(valueAt(flow, 4)).toBe(1);
		expect(valueAt(flow, 6)).toBe(2);
		expect(valueAt(flow, 50)).toBeNull();
		expect(valueAt(flow, 99)).toBe(3);
		expect(valueAt(flow, -3)).toBe(1);
	});

	it('reports a gap as no value', () => {
		expect(valueAt({ x: [0, 1], y: [null, 2] }, 0)).toBeNull();
		expect(valueAt({ x: [], y: [] }, 0)).toBeNull();
	});
});

describe('time axis', () => {
	it('steps by whole days once a label fits, and coarser over longer spans', () => {
		expect(timeStep(30 * DAY, 600)).toBe(7 * DAY);
		expect(timeStep(30 * DAY, 600, 30)).toBe(2 * DAY);
		expect(timeStep(30 * DAY, 1600)).toBe(DAY);
		expect(timeStep(365 * DAY, 600)).toBe(91 * DAY);
		expect(timeStep(0.2 * DAY, 600)).toBe(3600000);
	});

	it('counts ticks from the start of the record', () => {
		expect(timeTicks(0, 0, 4 * DAY, 2 * DAY)).toEqual([0, 2 * DAY, 4 * DAY]);
		expect(timeTicks(0, 1, 4 * DAY, 2 * DAY)).toEqual([2 * DAY, 4 * DAY]);
	});

	it('labels days, dates and hours in UTC', () => {
		const t = Date.UTC(2025, 10, 26, 13, 12);
		expect(timeTick(t, DAY, true)).toBe('26');
		expect(timeTick(t, DAY, false)).toBe('26 Nov');
		expect(timeTick(t, 3600000, false)).toBe('13:12');
		expect(timeReadout(t)).toBe('2025-11-26 13:12');
	});
});

describe('chartSummary', () => {
	it('names the series and the axes', () => {
		expect(chartSummary('Historical', 'Month', 'Discharge (m³/s)', [{ label: 'EWR Monthly Requirement' }, { label: 'Drought EWR' }], '')).toBe(
			'Historical. Shows EWR Monthly Requirement, Drought EWR. Discharge (m³/s) against Month.'
		);
		expect(chartSummary('Real time', 'Date', 'Q', [], '')).toContain('No data yet');
	});
});
