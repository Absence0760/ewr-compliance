// The Water Management Areas of 2023, the app's first choice, and the geometry tests that put
// catchments, gauges and rivers in one. Pure: no MapLibre, no fetch, no app state.
import type { Feature, Geometry, Position } from 'geojson';
import type { Bounds } from '#lib/components/map/mapData.ts';

export interface Wma {
	/** In the route, `wma/<slug>/`. */
	slug: string;
	/** As the gazette writes it. */
	name: string;
	/** `WMA_NAME` in the DWS WMA_2023 layer. */
	service: string;
	/** Extent, so the map can open on the area before the live boundary arrives. */
	bounds: Bounds;
}

/** The six WMAs, in their gazetted order. Lesotho and Eswatini are in the layer too, and are not WMAs. */
export const WMAS: Wma[] = [
	{ slug: 'limpopo-olifants', name: 'Limpopo-Olifants', service: 'Limpopo_Olifants', bounds: [[25.69, -26.52], [31.91, -22.12]] },
	{ slug: 'inkomati-usuthu', name: 'Inkomati-Usuthu', service: 'Inkomati_Usuthu', bounds: [[29.8, -27.32], [32.03, -24.17]] },
	{ slug: 'pongola-mtamvuna', name: 'Pongola-Mtamvuna', service: 'Pongola_Mtamvuna', bounds: [[28.87, -31.08], [32.89, -26.8]] },
	{ slug: 'vaal-orange', name: 'Vaal-Orange', service: 'Vaal_Orange', bounds: [[16.45, -32.67], [30.31, -24.77]] },
	{ slug: 'mzimvubu-tsitsikamma', name: 'Mzimvubu-Tsitsikamma', service: 'Mzimvubu_Tsitsikamma', bounds: [[22.42, -34.21], [30.19, -29.91]] },
	{ slug: 'breede-olifants', name: 'Breede-Olifants', service: 'Breede_Olifants', bounds: [[17.81, -34.84], [23.72, -29.81]] }
];

/** South Africa, for the national map. */
export const NATIONAL_BOUNDS: Bounds = [[16.45, -34.84], [32.89, -22.12]];

/**
 * The WMA each basin's nodes are in. All four study basins lie in Breede-Olifants: checked against
 * the DWS layers by `tools/check-live-services.ts`, which fails if a node's quaternary leaves it.
 */
export const BASIN_WMA: Record<string, string> = {
	Berg: 'breede-olifants',
	Breede: 'breede-olifants',
	Gouritz: 'breede-olifants',
	'Olifants-Doring': 'breede-olifants'
};

export const wmaBySlug = (slug: string): Wma | undefined => WMAS.find((w) => w.slug === slug);

export const wmaByService = (name: string): Wma | undefined => WMAS.find((w) => w.service === name);

/** The WMA a node of this basin is in. A basin missing from `BASIN_WMA` has none, and its nodes show on no WMA's map. */
export const wmaOfBasin = (basin: string): Wma | undefined => wmaBySlug(BASIN_WMA[basin] ?? '');

/** Rings of a polygon or multipolygon: outer rings and holes alike, which even-odd counting needs. */
export function ringsOf(g: Geometry | null | undefined): Position[][] {
	if (!g) return [];
	if (g.type === 'Polygon') return g.coordinates;
	if (g.type === 'MultiPolygon') return g.coordinates.flat();
	return [];
}

/** Even-odd ray casting. A point exactly on an edge may fall either way. */
export function inRings([x, y]: Position, rings: Position[][]): boolean {
	let inside = false;
	for (const r of rings) {
		for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
			const [xi, yi] = r[i];
			const [xj, yj] = r[j];
			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
		}
	}
	return inside;
}

/** Every vertex of a line or polygon, or the point itself. */
export function verticesOf(g: Geometry | null | undefined): Position[] {
	if (!g) return [];
	switch (g.type) {
		case 'Point':
			return [g.coordinates];
		case 'MultiPoint':
		case 'LineString':
			return g.coordinates;
		case 'MultiLineString':
		case 'Polygon':
			return g.coordinates.flat();
		case 'MultiPolygon':
			return g.coordinates.flat(2);
		default:
			return [];
	}
}

/**
 * Whether a catchment or gauge belongs to the area. WMAs are drawn along catchment edges, so a
 * neighbour's catchment shares vertices with the boundary: most of its vertices must be inside,
 * not merely one. A point is in or out.
 */
export function mostlyInside(f: Feature, rings: Position[][]): boolean {
	const v = verticesOf(f.geometry);
	if (!v.length) return false;
	const inside = v.filter((p) => inRings(p, rings)).length;
	return inside * 2 > v.length;
}

/** Whether any of a river's vertices is inside, so a river crossing a boundary is in both areas. */
export const touches = (f: Feature, rings: Position[][]): boolean => verticesOf(f.geometry).some((p) => inRings(p, rings));
