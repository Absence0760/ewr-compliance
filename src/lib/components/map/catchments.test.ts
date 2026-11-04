import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';
import {
	LIVE_TIMEOUT_MS, envelope, loadQuaternaries, namedQuaternaries, gaugeProperties, gaugeUrl, getAll, loadGauges, loadWmas, outlineOf, quaternaryUrl, queryUrl, reduceProperties, within, wmaUrl
} from './catchments.ts';
import { touches, wmaBySlug } from './wma.ts';

const WMA = wmaBySlug('breede-olifants')!;
/** A square from 0 to 10 each way, standing in for a WMA's outline. */
const SQUARE = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
const pointAt = (x: number, y: number): FeatureCollection['features'][number] => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: {} });

describe('catchments', () => {
	test('asks the service for GeoJSON in WGS84 with the given filter', () => {
		const u = new URL(queryUrl('WMA_2004', "WMA_Name IN ('Berg')", 'WMA_Name', 0.003, 4));
		expect(u.pathname).toContain('/WMA_2004/FeatureServer/0/query');
		expect(u.searchParams.get('where')).toBe("WMA_Name IN ('Berg')");
		expect(u.searchParams.get('f')).toBe('geojson');
		expect(u.searchParams.get('outSR')).toBe('4326');
	});

	test("asks for flow gauges in the WMA's box by station number, not by the Quat field", () => {
		const u = new URL(gaugeUrl(WMA));
		expect(u.searchParams.get('where')).toBe("Station LIKE '__H%'");
		expect(u.searchParams.get('geometry')).toBe('17.81,-34.84,23.72,-29.81');
		expect(u.searchParams.get('inSR')).toBe('4326');
		expect(u.searchParams.get('outFields')).toBe('Station,Name,Quat,Status');
		expect(u.searchParams.get('f')).toBe('geojson');
	});

	test("asks for the quaternaries crossing the WMA's box, and the WMA by its name in the 2023 layer", () => {
		const q = new URL(quaternaryUrl(WMA));
		expect(q.searchParams.get('where')).toBe('1=1');
		expect(q.searchParams.get('geometryType')).toBe('esriGeometryEnvelope');
		expect(q.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects');
		const w = new URL(wmaUrl(WMA));
		expect(w.pathname).toContain('/WMA_2023/FeatureServer/0/query');
		expect(w.searchParams.get('where')).toBe("WMA_NAME = 'Breede_Olifants'");
	});

	test('adds no box to a query that has none', () => {
		expect(envelope()).toEqual({});
		expect(new URL(queryUrl('WMA_2004', '1=1', 'WMA_Name', 0.003, 4)).searchParams.has('geometry')).toBe(false);
	});

	test("keeps what lies in the WMA's outline, or everything in the box when the outline is lost", () => {
		const fc: FeatureCollection = { type: 'FeatureCollection', features: [pointAt(5, 5), pointAt(15, 5)] };
		expect(within(fc, SQUARE as never).features).toHaveLength(1);
		expect(within(fc, null).features).toHaveLength(2);
		const line = (x: number): FeatureCollection['features'][number] => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[x, 5], [x + 10, 5]] }, properties: {} });
		expect(within({ type: 'FeatureCollection', features: [line(5), line(20)] }, SQUARE as never, touches).features).toHaveLength(1);
	});

	test("keeps a quaternary a node of the WMA names, though it lies mostly outside", async () => {
		const quat = (QUATERNARY: string, x: number) => ({
			type: 'Feature', properties: { QUATERNARY }, geometry: { type: 'Polygon', coordinates: [[[x, 1], [x + 2, 1], [x + 2, 3], [x, 3], [x, 1]]] }
		});
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'FeatureCollection', features: [quat('Z10A', 1), quat('Z10B', 20), quat('Z10C', 30)] })));
		const named = namedQuaternaries([{ quat: 'Z10B / Z10D' }, { quat: '' }]);
		expect([...named]).toEqual(['Z10B', 'Z10D']);
		expect((await loadQuaternaries(WMA, SQUARE as never, named)).features.map((f) => f.properties?.q)).toEqual(['Z10A', 'Z10B']);
		vi.unstubAllGlobals();
	});

	test('reads the outline of every polygon and multipolygon', () => {
		const fc: FeatureCollection = {
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', geometry: { type: 'Polygon', coordinates: SQUARE }, properties: {} },
				{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [SQUARE, SQUARE] }, properties: {} }
			]
		};
		expect(outlineOf(fc)).toHaveLength(3);
	});

	test('names each WMA by its slug, and gives Lesotho and Eswatini none, so they cannot be chosen', async () => {
		const square = (WMA_NAME: string) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: SQUARE }, properties: { WMA_NAME } });
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'FeatureCollection', features: [square('Vaal_Orange'), square('Lesotho')] })));
		expect((await loadWmas()).features.map((f) => f.properties)).toEqual([{ w: 'vaal-orange', name: 'Vaal-Orange' }, { w: '', name: 'Lesotho' }]);
		vi.unstubAllGlobals();
	});

	test('orders every query, so that pages of it cannot overlap', () => {
		for (const url of [gaugeUrl(WMA), quaternaryUrl(WMA), wmaUrl(WMA), queryUrl('WMA_2004', '1=1', 'WMA_Name', 0.003, 4)]) {
			expect(new URL(url).searchParams.get('orderByFields')).toBe('OBJECTID');
		}
	});

	test('reads a gauge, and treats anything not active as closed', () => {
		const gauge = (Status: string): FeatureCollection['features'][number] => ({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [21, -34.25] },
			properties: { Station: 'X0H001', Name: ' Sample River @ Sample Weir ', Quat: 'Z80A', Status, OBJECTID: 1 }
		});
		const [open, closed] = gaugeProperties({ type: 'FeatureCollection', features: [gauge('Active Weirs'), gauge('Inactive Weirs')] }).features;
		expect(open.properties).toEqual({
			station: 'X0H001', name: 'Sample River @ Sample Weir', quat: 'Z80A', closed: false, label: 'X0H001 Sample River @ Sample Weir'
		});
		expect(closed.properties?.closed).toBe(true);
	});

	test('has no quaternary for a gauge whose Quat field is 0', () => {
		const fc: FeatureCollection = {
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [19, -34] }, properties: { Station: 'H6H999', Name: 'Test', Quat: '0', Status: 'Active Weirs' } }]
		};
		expect(gaugeProperties(fc).features[0].properties?.quat).toBe('');
	});

	test('reduces each feature to the one trimmed property', () => {
		const fc: FeatureCollection = {
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [18, -33] }, properties: { QUATERNARY: ' Z10A ', OBJECTID: 7 } }]
		};
		expect(reduceProperties(fc, 'QUATERNARY', 'q').features[0].properties).toEqual({ q: 'Z10A' });
	});
});

describe('getAll', () => {
	const URL_ = 'https://example.test/query?f=geojson';
	const point = (Station: string) => ({
		type: 'Feature', geometry: { type: 'Point', coordinates: [21, -34] }, properties: { Station, Name: 'Test', Quat: 'Z80A', Status: 'Active Weirs' }
	});
	/** The service's answer: `properties` carries the flag in GeoJSON, as the live layers do. */
	const page = (stations: string[], cutOff = false) => ({
		type: 'FeatureCollection', features: stations.map(point), ...(cutOff ? { properties: { exceededTransferLimit: true } } : {})
	});
	const answer = (...bodies: unknown[]) => {
		const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
		for (const body of bodies) fetch.mockResolvedValueOnce(Response.json(body));
		vi.stubGlobal('fetch', fetch);
		return fetch;
	};
	const stations = (fc: FeatureCollection) => fc.features.map((f) => f.properties?.Station);

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test('makes one request when nothing is cut off', async () => {
		const fetch = answer(page(['A', 'B']));
		expect(stations(await getAll(URL_))).toEqual(['A', 'B']);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([URL_]);
	});

	test('follows a cut-off result from where it stopped, to the last page', async () => {
		const fetch = answer(page(['A', 'B'], true), page(['C', 'D'], true), page(['E']));
		expect(stations(await getAll(URL_))).toEqual(['A', 'B', 'C', 'D', 'E']);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([URL_, `${URL_}&resultOffset=2`, `${URL_}&resultOffset=4`]);
	});

	test('pages the gauge query too', async () => {
		const fetch = answer(page(['H1H001'], true), page(['H1H002']));
		expect((await loadGauges(WMA, null)).features.map((f) => f.properties?.station)).toEqual(['H1H001', 'H1H002']);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test('fails rather than show part of a layer when a later page fails', async () => {
		answer(page(['A'], true), { error: { code: 400, message: '', details: ['nope'] } });
		await expect(getAll(URL_)).rejects.toThrow();
	});

	test('fails on an empty result, which would otherwise be a silent gap', async () => {
		answer(page([]));
		await expect(getAll(URL_)).rejects.toThrow('No features');
	});

	test('gives up on a service that says every page is cut off', async () => {
		const fetch = vi.fn(async () => Response.json(page(['A'], true)));
		vi.stubGlobal('fetch', fetch);
		await expect(getAll(URL_)).rejects.toThrow('No end after 20 pages');
		expect(fetch).toHaveBeenCalledTimes(20);
	});

	test('fails on an HTTP error, and on an error sent with HTTP 200', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Request', { status: 400 })));
		await expect(getAll(URL_)).rejects.toThrow('HTTP 400');
		answer({ error: { code: 400, message: 'Invalid query' } });
		await expect(getAll(URL_)).rejects.toThrow('Invalid query');
	});

	test('gives a request a time limit, so a service that hangs counts as down', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
		vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
			init.signal?.throwIfAborted();
			return Response.json(page(['A']));
		}));
		await expect(getAll(URL_)).rejects.toThrow();
		expect(timeout).toHaveBeenCalledWith(LIVE_TIMEOUT_MS);
	});
});
