// The map's style: a Protomaps base map when a tiles URL is set, otherwise a plain background,
// then the catchment, river and basin layers, then the points. Names are exported because
// EwrMap toggles and queries these layers. Node and site labels are DOM markers (EwrMap).
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

export const NODE_BLUE = '#2a78d6';
export const NODE_EDGE = '#124a8c';
export const SITE_ORANGE = '#eb6834';
export const SITE_EDGE = '#8a3a18';
export const NO_FILE_EDGE = '#77766f';
export const BASIN_BLACK = '#111111';
export const RIVER_BLUE = '#3f86c9';
export const QUAT_LINE = '#6f6e69';
export const QUAT_TINT = '#f6f5ef';
export const GAUGE_GREEN = '#0e7c5a';

export const QUAT_FILL = 'quat-fill';
export const QUAT_LINES = 'quat-line';
export const RIVERS = 'rivers';
export const BASINS = 'basins';
export const GAUGES = 'gauges';
export const GAUGES_CLOSED = 'gauges-closed';
export const NO_FILE = 'nodes-no-file';
export const SITES = 'sites';
export const NODES = 'nodes';

export const BASEMAP_SOURCE = 'basemap';
export const DIAMOND = 'site-diamond';
export const GAUGE_ICON = 'gauge-triangle';
export const GAUGE_CLOSED_ICON = 'gauge-triangle-closed';
export const POINT_LAYERS: string[] = [GAUGES_CLOSED, GAUGES, NO_FILE, SITES, NODES];

export const CREDIT = 'Catchments and basins: DWS · Rivers: DWS 1:500k · Flow gauges: University of Pretoria, SAHA';
export const BASEMAP_CREDIT = '© Protomaps © OpenStreetMap contributors';

const LAND = { bg: '#eef0ea', earth: '#e4e7df', water: '#a9cfe0', green: '#d3e3c6', road: '#ffffff', roadCase: '#c9cdc4', border: '#9a9f97' };
const FONTS = { regular: 'Noto Sans Regular', medium: 'Noto Sans Medium', italic: 'Noto Sans Italic' };
const LABEL = { text: '#1f2320', water: '#073a57', halo: '#ffffff' };
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];
const roadWidth = (scale: number) => ['interpolate', ['linear'], ['zoom'], 8, 0.4 * scale, 14, 3 * scale];

function labelLayers(): LayerSpecification[] {
	const halo = { 'text-halo-color': LABEL.halo, 'text-halo-width': 1.5, 'text-halo-blur': 0.25 };
	return [
		{
			id: 'bm-label-water',
			type: 'symbol',
			source: BASEMAP_SOURCE,
			'source-layer': 'water',
			filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']],
			layout: { 'text-field': NAME, 'text-font': [FONTS.italic], 'text-size': 12, 'text-max-width': 9 },
			paint: { 'text-color': LABEL.water, ...halo }
		},
		{
			id: 'bm-label-places',
			type: 'symbol',
			source: BASEMAP_SOURCE,
			'source-layer': 'places',
			filter: ['all', ['in', ['get', 'kind'], ['literal', ['locality', 'region', 'neighbourhood']]], ['has', 'name']],
			layout: {
				'text-field': NAME,
				'text-font': [FONTS.regular],
				'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 12, 14],
				'text-max-width': 8,
				'symbol-sort-key': ['coalesce', ['get', 'sort_key'], ['get', 'min_zoom'], 99]
			},
			paint: { 'text-color': LABEL.text, ...halo }
		}
	] as unknown as LayerSpecification[];
}

/** The first label layer, which overlay lines go under so town names stay readable. */
export const FIRST_LABEL = 'bm-label-water';

/** A background, plus the Protomaps layers when there is a tiles URL, plus labels when there are glyphs. */
export function baseStyle(tilesUrl: string | null, glyphs: string | null): StyleSpecification {
	const background: LayerSpecification = { id: 'background', type: 'background', paint: { 'background-color': LAND.bg } };
	if (!tilesUrl) return { version: 8, sources: {}, layers: [background] };
	const src = { source: BASEMAP_SOURCE };
	const layers = [
		background,
		{ id: 'bm-earth', type: 'fill', ...src, 'source-layer': 'earth', paint: { 'fill-color': LAND.earth } },
		{ id: 'bm-landcover', type: 'fill', ...src, 'source-layer': 'landcover', filter: ['in', ['get', 'kind'], ['literal', ['forest', 'grassland', 'scrub']]], paint: { 'fill-color': LAND.green, 'fill-opacity': 0.6 } },
		{ id: 'bm-landuse', type: 'fill', ...src, 'source-layer': 'landuse', filter: ['in', ['get', 'kind'], ['literal', ['park', 'nature_reserve', 'farmland']]], paint: { 'fill-color': LAND.green, 'fill-opacity': 0.4 } },
		// Polygons only: a fill layer closes the water layer's river lines into false wedges of water.
		{ id: 'bm-water', type: 'fill', ...src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': LAND.water } },
		{ id: 'bm-waterways', type: 'line', ...src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': LAND.water, 'line-width': 1 } },
		{ id: 'bm-boundaries', type: 'line', ...src, 'source-layer': 'boundaries', paint: { 'line-color': LAND.border, 'line-width': 1, 'line-dasharray': [3, 2] } },
		{ id: 'bm-roads-case', type: 'line', ...src, 'source-layer': 'roads', minzoom: 9, paint: { 'line-color': LAND.roadCase, 'line-width': roadWidth(1.5) } },
		{ id: 'bm-roads', type: 'line', ...src, 'source-layer': 'roads', paint: { 'line-color': LAND.road, 'line-width': roadWidth(1) } },
		...(glyphs ? labelLayers() : [])
	] as LayerSpecification[];
	return {
		version: 8,
		...(glyphs ? { glyphs } : {}),
		sources: { [BASEMAP_SOURCE]: { type: 'vector', url: `pmtiles://${tilesUrl}`, attribution: BASEMAP_CREDIT } },
		layers
	};
}

/** IDs of the base map's layers, for the legend's switch. */
export const basemapLayerIds = (style: StyleSpecification) => style.layers.filter((l) => l.id.startsWith('bm-')).map((l) => l.id);

/** Bottom to top. Sites sit under nodes, and are larger, so a co-located pair shows both. */
export const OVERLAY_LAYERS: LayerSpecification[] = [
	{
		id: QUAT_FILL,
		type: 'fill',
		source: 'quaternaries',
		paint: { 'fill-color': QUAT_TINT, 'fill-opacity': 0.55 }
	},
	{
		id: QUAT_LINES,
		type: 'line',
		source: 'quaternaries',
		paint: { 'line-color': QUAT_LINE, 'line-width': 1 }
	},
	{
		id: RIVERS,
		type: 'line',
		source: 'rivers',
		layout: { 'line-cap': 'round', 'line-join': 'round' },
		paint: {
			'line-color': RIVER_BLUE,
			'line-opacity': 0.85,
			'line-width': ['min', 3, ['+', 0.6, ['*', 0.55, ['-', ['coalesce', ['get', 's'], 1], 1]]]]
		}
	},
	{
		id: BASINS,
		type: 'line',
		source: 'basins',
		layout: { 'line-join': 'round' },
		paint: { 'line-color': BASIN_BLACK, 'line-width': 3 }
	},
	{
		id: NO_FILE,
		type: 'circle',
		source: 'nodes',
		filter: ['!', ['get', 'usable']],
		layout: { visibility: 'none' },
		paint: {
			'circle-radius': 3.5,
			'circle-color': '#ffffff',
			'circle-stroke-color': NO_FILE_EDGE,
			'circle-stroke-width': 1
		}
	},
	{
		id: GAUGES_CLOSED,
		type: 'symbol',
		source: 'gauges',
		filter: ['get', 'closed'],
		layout: { visibility: 'none', 'icon-image': GAUGE_CLOSED_ICON, 'icon-allow-overlap': true, 'icon-ignore-placement': true }
	},
	{
		id: GAUGES,
		type: 'symbol',
		source: 'gauges',
		filter: ['!', ['get', 'closed']],
		layout: { 'icon-image': GAUGE_ICON, 'icon-allow-overlap': true, 'icon-ignore-placement': true }
	},
	{
		id: SITES,
		type: 'symbol',
		source: 'sites',
		layout: { 'icon-image': DIAMOND, 'icon-allow-overlap': true, 'icon-ignore-placement': true }
	},
	{
		id: NODES,
		type: 'circle',
		source: 'nodes',
		filter: ['get', 'usable'],
		paint: {
			'circle-radius': 5,
			'circle-color': ['case', ['get', 'approx'], '#ffffff', NODE_BLUE],
			'circle-stroke-color': ['case', ['get', 'approx'], NODE_BLUE, NODE_EDGE],
			'circle-stroke-width': ['case', ['get', 'approx'], 2, 1]
		}
	}
];

/** The gauge symbol: a green triangle, or a hollow one for a closed gauge. */
export function gaugeImage(closed: boolean, pixelRatio = 2): ImageData {
	const size = 16 * pixelRatio;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const c = canvas.getContext('2d', { willReadFrequently: true })!;
	c.beginPath();
	c.moveTo(size / 2, 2.5 * pixelRatio);
	c.lineTo(size - 2.5 * pixelRatio, size - 3 * pixelRatio);
	c.lineTo(2.5 * pixelRatio, size - 3 * pixelRatio);
	c.closePath();
	c.lineJoin = 'round';
	c.fillStyle = closed ? '#ffffff' : GAUGE_GREEN;
	c.fill();
	c.strokeStyle = closed ? GAUGE_GREEN : '#ffffff';
	c.lineWidth = 1.5 * pixelRatio;
	c.stroke();
	return c.getImageData(0, 0, size, size);
}

/** The site symbol: an orange diamond with a white edge and a thin dark outline. */
export function diamondImage(pixelRatio = 2): ImageData {
	const size = 24 * pixelRatio;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const c = canvas.getContext('2d', { willReadFrequently: true })!;
	const mid = size / 2;
	const half = 9 * pixelRatio;
	c.beginPath();
	c.moveTo(mid, mid - half);
	c.lineTo(mid + half, mid);
	c.lineTo(mid, mid + half);
	c.lineTo(mid - half, mid);
	c.closePath();
	c.lineJoin = 'round';
	c.strokeStyle = SITE_EDGE;
	c.lineWidth = 3 * pixelRatio;
	c.stroke();
	c.strokeStyle = '#ffffff';
	c.lineWidth = 2 * pixelRatio;
	c.stroke();
	c.fillStyle = SITE_ORANGE;
	c.fill();
	return c.getImageData(0, 0, size, size);
}
