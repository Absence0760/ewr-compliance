import { describe, expect, test } from 'vitest';
import type { Feature } from 'geojson';
import { BASIN_WMA, NATIONAL_BOUNDS, WMAS, inRings, mostlyInside, ringsOf, touches, verticesOf, wmaByService, wmaBySlug, wmaOfBasin } from './wma.ts';

const SQUARE = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
const polygon = (coordinates: number[][][]): Feature => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates }, properties: {} });

describe('the WMAs', () => {
	test('are the six of 2023, each with a slug fit for a URL and a box inside the national one', () => {
		expect(WMAS.map((w) => w.name)).toEqual(['Limpopo-Olifants', 'Inkomati-Usuthu', 'Pongola-Mtamvuna', 'Vaal-Orange', 'Mzimvubu-Tsitsikamma', 'Breede-Olifants']);
		for (const w of WMAS) {
			expect(w.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
			const [[x0, y0], [x1, y1]] = w.bounds;
			expect(x0 < x1 && y0 < y1).toBe(true);
			expect(x0 >= NATIONAL_BOUNDS[0][0] && y0 >= NATIONAL_BOUNDS[0][1] && x1 <= NATIONAL_BOUNDS[1][0] && y1 <= NATIONAL_BOUNDS[1][1]).toBe(true);
		}
	});

	test('write each name inside the WMA, within its box', () => {
		for (const { label: [x, y], bounds: [[w, s], [e, n]] } of WMAS) expect(x > w && x < e && y > s && y < n).toBe(true);
	});

	test('are found by slug and by their name in the DWS layer', () => {
		expect(wmaBySlug('vaal-orange')?.service).toBe('Vaal_Orange');
		expect(wmaByService('Breede_Olifants')?.slug).toBe('breede-olifants');
		expect(wmaBySlug('lesotho')).toBeUndefined();
	});

	test('put every study basin in Breede-Olifants, and a basin they do not know in none', () => {
		for (const basin of Object.keys(BASIN_WMA)) expect(wmaOfBasin(basin)?.slug).toBe('breede-olifants');
		expect(wmaOfBasin('Elsewhere')).toBeUndefined();
	});
});

describe('the geometry tests', () => {
	test('a point is inside a ring, outside it, or inside a hole and so outside', () => {
		expect(inRings([5, 5], SQUARE)).toBe(true);
		expect(inRings([15, 5], SQUARE)).toBe(false);
		const holed = [...SQUARE, [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
		expect(inRings([5, 5], holed)).toBe(false);
		expect(inRings([2, 2], holed)).toBe(true);
	});

	test('reads the rings of a multipolygon, and none from a line', () => {
		expect(ringsOf({ type: 'MultiPolygon', coordinates: [SQUARE, SQUARE] })).toHaveLength(2);
		expect(ringsOf({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toEqual([]);
		expect(ringsOf(null)).toEqual([]);
	});

	test('reads the vertices of every kind of geometry', () => {
		expect(verticesOf({ type: 'Point', coordinates: [1, 2] })).toEqual([[1, 2]]);
		expect(verticesOf({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2]]] })).toHaveLength(3);
		expect(verticesOf({ type: 'MultiPolygon', coordinates: [SQUARE] })).toHaveLength(5);
	});

	test('a catchment belongs to the WMA most of whose vertices it has, not to a neighbour it shares an edge with', () => {
		// Shares the edge x = 10 with the square, so two of its four corners are on it.
		const neighbour = polygon([[[10, 2], [14, 2], [14, 8], [10, 8], [10, 2]]]);
		expect(mostlyInside(neighbour, SQUARE)).toBe(false);
		expect(mostlyInside(polygon([[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]), SQUARE)).toBe(true);
		expect(mostlyInside({ type: 'Feature', geometry: { type: 'Point', coordinates: [5, 5] }, properties: {} }, SQUARE)).toBe(true);
	});

	test('a river crossing the boundary touches the WMAs on both sides', () => {
		const river: Feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[8, 5], [12, 5]] }, properties: {} };
		expect(touches(river, SQUARE)).toBe(true);
		expect(touches(river, [[[11, 0], [20, 0], [20, 10], [11, 10], [11, 0]]])).toBe(true);
		expect(touches(river, [[[30, 0], [40, 0], [40, 10], [30, 10], [30, 0]]])).toBe(false);
	});
});
