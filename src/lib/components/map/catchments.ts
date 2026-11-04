// Catchment and WMA boundaries, read live from the Department of Water and Sanitation's
// public service. DWS supplies this data without distribution rights, so no copy is kept in
// this repository or its build: each browser fetches it directly from the source.
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { Bounds } from '#lib/components/map/mapData.ts';
import { WMAS, mostlyInside, ringsOf, type Wma } from '#lib/components/map/wma.ts';

const SERVICE = 'https://services3.arcgis.com/QdLJLZBqzVAhCil8/ArcGIS/rest/services';

/** Water Management Areas of 2004, which match the four basin folders. */
const BASIN_WHERE = "WMA_Name IN ('Berg','Breede','Gouritz','Olifants/Doorn')";

/** The WMAs of 2023, which the app opens on. */
export const WMA_LAYER = 'WMA_2023';

/**
 * DWS has no public gauge service, so this is the South African Hydropower Atlas layer (University
 * of Pretoria and the WRC), taken from DWS reports. It may be downloaded, with credit to the author.
 */
const GAUGES =
	'https://services8.arcgis.com/ZhTpwEGNVUBxG9VW/arcgis/rest/services/Active_and_Inactive_Gauging_Weirs/FeatureServer/0/query';

/**
 * Flow gauges, by station number: an H third is a flow gauge, an R a reservoir. Not by the layer's
 * Quat field, which is 0 for some gauges, or they would drop out.
 */
const GAUGE_WHERE = "Station LIKE '__H%'";

/** A service that has not answered by now is treated as down. A cold one takes 6 s for the quaternaries. */
export const LIVE_TIMEOUT_MS = 30_000;

/** Far beyond the 1166 quaternaries of the largest WMA, at the layers' limit of 2000 a page. It stops a service that never finishes. */
const MAX_PAGES = 20;

export function queryUrl(layer: string, where: string, outFields: string, offset: number, precision: number, within?: Bounds): string {
	const q = new URLSearchParams({
		where, outFields, ...envelope(within), orderByFields: 'OBJECTID', outSR: '4326', maxAllowableOffset: String(offset), geometryPrecision: String(precision), f: 'geojson'
	});
	return `${SERVICE}/${layer}/FeatureServer/0/query?${q}`;
}

/** What crosses a box, in lon/lat. The service filters by the box, and the app by the WMA's own outline. */
export function envelope(within?: Bounds): Record<string, string> {
	if (!within) return {};
	const [[w, s], [e, n]] = within;
	return { geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
}

/** Keep one short property on each feature, so the rest of the map ignores the service's field names. */
export function reduceProperties(fc: FeatureCollection, from: string, to: string): FeatureCollection {
	return {
		type: 'FeatureCollection',
		features: fc.features.map((f) => ({ ...f, properties: { [to]: String(f.properties?.[from] ?? '').trim() } }))
	};
}

/** One feature of the study-area gauge layer, reduced to what the map shows. */
export interface Gauge {
	station: string;
	name: string;
	quat: string;
	closed: boolean;
	label: string;
}

/** The DWS station number and river name, with whether the gauge has closed. */
export function gaugeProperties(fc: FeatureCollection): FeatureCollection {
	const text = (v: unknown) => String(v ?? '').trim();
	return {
		type: 'FeatureCollection',
		features: fc.features.map((f) => {
			const station = text(f.properties?.Station);
			const name = text(f.properties?.Name);
			const quat = text(f.properties?.Quat);
			const gauge: Gauge = {
				station, name, quat: quat === '0' ? '' : quat, closed: text(f.properties?.Status) !== 'Active Weirs', label: `${station} ${name}`
			};
			return { ...f, properties: gauge };
		})
	};
}

/** ArcGIS answers an error with HTTP 200, and in GeoJSON reports a cut-off result under `properties`. */
type ServiceResponse = FeatureCollection & { error?: { message?: string }; properties?: { exceededTransferLimit?: boolean } };

async function get(url: string): Promise<ServiceResponse> {
	const res = await fetch(url, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as ServiceResponse;
	if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'Unexpected response');
	return body;
}

/**
 * Every feature of a query, page by page, because a service stops at its record limit and only says
 * so in a flag. The url must set `orderByFields`, or pages can overlap. A query here always covers
 * a WMA, and every WMA has catchments and gauges, so an empty result means something is wrong.
 */
export async function getAll(url: string): Promise<FeatureCollection> {
	const features: FeatureCollection['features'] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const body = await get(page ? `${url}&resultOffset=${features.length}` : url);
		features.push(...body.features);
		if (body.properties?.exceededTransferLimit) continue;
		if (!features.length) throw new Error('No features');
		return { type: 'FeatureCollection', features };
	}
	throw new Error(`No end after ${MAX_PAGES} pages`);
}

export const quaternaryUrl = (wma: Wma) => queryUrl('Quaternary_Catchments', '1=1', 'QUATERNARY', 0.003, 4, wma.bounds);

export const basinUrl = () => queryUrl('WMA_2004', BASIN_WHERE, 'WMA_Name', 0.003, 4);

/** Every WMA, coarse enough for the national map. */
export const wmasUrl = () => queryUrl(WMA_LAYER, '1=1', 'WMA_NAME', 0.01, 3);

/** One WMA's outline, as fine as the catchments inside it. */
export const wmaUrl = (wma: Wma) => queryUrl(WMA_LAYER, `WMA_NAME = '${wma.service}'`, 'WMA_NAME', 0.003, 4);

export const gaugeUrl = (wma: Wma) =>
	`${GAUGES}?${new URLSearchParams({ where: GAUGE_WHERE, outFields: 'Station,Name,Quat,Status', ...envelope(wma.bounds), orderByFields: 'OBJECTID', outSR: '4326', f: 'geojson' })}`;

/**
 * Keep what lies in the WMA. The service answers for the WMA's box, which takes in some of its
 * neighbours. With no outline, because its layer failed, the box is all there is to go on.
 */
export function within(fc: FeatureCollection, outline: Position[][] | null, keep: (f: Feature, rings: Position[][]) => boolean = mostlyInside): FeatureCollection {
	return outline ? { ...fc, features: fc.features.filter((f) => keep(f, outline)) } : fc;
}

/** Rings of every polygon in the collection, for `within`. */
export const outlineOf = (fc: FeatureCollection): Position[][] => fc.features.flatMap((f) => ringsOf(f.geometry));

/**
 * Every WMA with `w`, its slug, and `name`. Lesotho and Eswatini are in the layer and are not WMAs:
 * their `w` is '', so they are drawn and cannot be chosen.
 */
export const loadWmas = () =>
	getAll(wmasUrl()).then((fc): FeatureCollection => ({
		type: 'FeatureCollection',
		features: fc.features.map((f) => {
			const service = String(f.properties?.WMA_NAME ?? '').trim();
			const wma = WMAS.find((w) => w.service === service);
			return { ...f, properties: { w: wma?.slug ?? '', name: wma?.name ?? service.replace(/_/g, ' ') } };
		})
	}));

export const loadWma = (wma: Wma) => getAll(wmaUrl(wma)).then((fc) => reduceProperties(fc, 'WMA_NAME', 'w'));

/**
 * The WMA's quaternaries, and any a node of the WMA names: a node goes with its basin's WMA, and its
 * quaternary may lie mostly over the line, so it is drawn with the node.
 */
export const loadQuaternaries = (wma: Wma, outline: Position[][] | null, named: Set<string> = new Set()) =>
	getAll(quaternaryUrl(wma)).then((fc) =>
		within(reduceProperties(fc, 'QUATERNARY', 'q'), outline, (f, rings) => named.has(String(f.properties?.q)) || mostlyInside(f, rings))
	);

/** The quaternaries these nodes name. A node can name two, split by a slash, or none at all. */
export const namedQuaternaries = (nodes: { quat: string }[]): Set<string> =>
	new Set(nodes.flatMap((n) => n.quat.split('/').map((q) => q.trim()).filter(Boolean)));

export const loadBasins = () => getAll(basinUrl()).then((fc) => reduceProperties(fc, 'WMA_Name', 'b'));

export const loadGauges = (wma: Wma, outline: Position[][] | null) => getAll(gaugeUrl(wma)).then((fc) => within(gaugeProperties(fc), outline));
