// Catchment and basin boundaries, read live from the Department of Water and Sanitation's
// public service. DWS supplies this data without distribution rights, so no copy is kept in
// this repository or its build: each browser fetches it directly from the source.
import type { FeatureCollection } from 'geojson';

const SERVICE = 'https://services3.arcgis.com/QdLJLZBqzVAhCil8/ArcGIS/rest/services';

/** Study-area quaternaries: Olifants-Doorn, Berg, Breede-Overberg and Gouritz. */
const QUATERNARY_WHERE =
	"PRIMARY_ IN ('E','G','H','J') OR TERTIARY IN ('F60','K10','K20','K30','K40','K50','K60','K70')";

/** Water Management Areas of 2004, which match the four basin folders. */
const BASIN_WHERE = "WMA_Name IN ('Berg','Breede','Gouritz','Olifants/Doorn')";

/**
 * DWS has no public gauge service, so this is the South African Hydropower Atlas layer (University
 * of Pretoria and the WRC), taken from DWS reports. It may be downloaded, with credit to the author.
 */
const GAUGES =
	'https://services8.arcgis.com/ZhTpwEGNVUBxG9VW/arcgis/rest/services/Active_and_Inactive_Gauging_Weirs/FeatureServer/0/query';

/**
 * The same study area as the quaternaries, by the drainage region at the start of the station
 * number. An H third is a flow gauge: R is a reservoir. Not by the layer's Quat field, which is 0 for
 * some gauges, or they would drop out.
 */
const GAUGE_WHERE = ['E_', 'G_', 'H_', 'J_', 'F6', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'].map((p) => `Station LIKE '${p}H%'`).join(' OR ');

/** A service that has not answered by now is treated as down. A cold one takes 6 s for the quaternaries. */
export const LIVE_TIMEOUT_MS = 30_000;

/** Far beyond the 326 quaternaries and 566 gauges at the layers' limit of 2000 a page. It stops a service that never finishes. */
const MAX_PAGES = 20;

export function queryUrl(layer: string, where: string, outFields: string, offset: number, precision: number): string {
	const q = new URLSearchParams({
		where, outFields, orderByFields: 'OBJECTID', outSR: '4326', maxAllowableOffset: String(offset), geometryPrecision: String(precision), f: 'geojson'
	});
	return `${SERVICE}/${layer}/FeatureServer/0/query?${q}`;
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
 * part of the study area, so an empty result means something is wrong, not that there is nothing.
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

export const quaternaryUrl = () => queryUrl('Quaternary_Catchments', QUATERNARY_WHERE, 'QUATERNARY', 0.003, 4);

export const basinUrl = () => queryUrl('WMA_2004', BASIN_WHERE, 'WMA_Name', 0.003, 4);

export const gaugeUrl = () =>
	`${GAUGES}?${new URLSearchParams({ where: GAUGE_WHERE, outFields: 'Station,Name,Quat,Status', orderByFields: 'OBJECTID', outSR: '4326', f: 'geojson' })}`;

export const loadQuaternaries = () => getAll(quaternaryUrl()).then((fc) => reduceProperties(fc, 'QUATERNARY', 'q'));

export const loadBasins = () => getAll(basinUrl()).then((fc) => reduceProperties(fc, 'WMA_Name', 'b'));

export const loadGauges = () => getAll(gaugeUrl()).then(gaugeProperties);
