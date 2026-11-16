// Pure logic for the map: what gets drawn, labelled and found. No MapLibre, no app state.
import type { FeatureCollection } from 'geojson';
import type { EwrNode, EwrSite, NodeFile, NodeInfo, NodeView } from '#lib/ewr/types.ts';
import { KIND_LABEL } from '#lib/ewr/format.ts';

type Position = [number, number];

interface PointFeature<P> {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: Position };
	properties: P;
}

export interface PointCollection<P> {
	type: 'FeatureCollection';
	features: PointFeature<P>[];
}

/** `usable` picks the layer; `approx` picks white fill and a blue ring. */
export interface NodeProps {
	id: string;
	label: string;
	usable: boolean;
	approx: boolean;
}

/** `i` indexes app.sites. `node` is '' when no node is linked (a null would not survive the worker). */
export interface SiteProps {
	i: number;
	label: string;
	node: string;
}

export interface MapLabel {
	key: string;
	text: string;
	lngLat: Position;
}

export type SearchTarget = { kind: 'node'; id: string } | { kind: 'site'; index: number };

export interface SearchEntry {
	/** Text in the datalist: the label, plus the basin when the label alone is ambiguous. */
	value: string;
	label: string;
	target: SearchTarget;
}

/** Longitude and latitude ranges, as [[west, south], [east, north]]. */
export type Bounds = [Position, Position];

const point = <P>(lon: number, lat: number, properties: P): PointFeature<P> => ({
	type: 'Feature',
	geometry: { type: 'Point', coordinates: [lon, lat] },
	properties
});

export const isUsable = (n: EwrNode): boolean => n.ecsAvailable.length > 0;

const hasPosition = (n: EwrNode): n is EwrNode & { lon: number; lat: number } => n.lon !== null && n.lat !== null;

/** The node's label with the sites at it, for example `syt1 / SYN-SITE1`. */
export function nodeLabel(n: EwrNode): string {
	const sites = n.sites.map((s) => s.label);
	return sites.length ? `${n.label} / ${sites.join(', ')}` : n.label;
}

export function nodeFeatures(nodes: EwrNode[]): PointCollection<NodeProps> {
	return {
		type: 'FeatureCollection',
		features: nodes.filter(hasPosition).map((n) =>
			point(n.lon, n.lat, { id: n.id, label: nodeLabel(n), usable: isUsable(n), approx: n.approx })
		)
	};
}

export function siteFeatures(sites: EwrSite[], nodes: EwrNode[]): PointCollection<SiteProps> {
	const ids = new Set(nodes.map((n) => n.id));
	return {
		type: 'FeatureCollection',
		features: sites.map((s, i) =>
			point(s.lon, s.lat, { i, label: s.label, node: s.node && ids.has(s.node) ? s.node : '' })
		)
	};
}

/**
 * Labels to show at label zoom. A node carries the sites at it, so a site gets its own label
 * only where that would otherwise go missing: no node, a node elsewhere, or a node hidden with
 * the no-EC-file layer.
 */
export function labelPoints(nodes: EwrNode[], sites: EwrSite[], showNoFile: boolean): MapLabel[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const shown = (n: EwrNode) => hasPosition(n) && (showNoFile || isUsable(n));
	const onNodeLabel = (s: EwrSite) => {
		const n = s.node ? byId.get(s.node) : undefined;
		return !!n && shown(n) && n.lon === s.lon && n.lat === s.lat && n.sites.some((x) => x.label === s.label);
	};
	return [
		...nodes.filter(shown).map((n) => ({
			key: `node:${n.id}`,
			text: nodeLabel(n),
			lngLat: [n.lon, n.lat] as Position
		})),
		...sites.flatMap((s, i) =>
			onNodeLabel(s) ? [] : [{ key: `site:${i}`, text: s.label, lngLat: [s.lon, s.lat] as Position }]
		)
	];
}

/** A label for each gauge on a layer that is switched on, with the station number as its text. */
export function gaugeLabels(gauges: FeatureCollection | null, showOpen: boolean, showClosed: boolean): MapLabel[] {
	return (gauges?.features ?? []).flatMap((f, i) => {
		const on = f.properties?.closed ? showClosed : showOpen;
		return on ? [{ key: `gauge:${i}`, text: f.properties?.station as string, lngLat: (f.geometry as unknown as { coordinates: Position }).coordinates }] : [];
	});
}

/**
 * Everything the search can find: nodes, sites, and site names known only from a node. Some
 * labels repeat, across basins and even on two nodes of one basin (a site number can recur within a basin),
 * so a repeat is listed with its basin, then its node, to keep each one reachable.
 */
export function searchEntries(nodes: EwrNode[], sites: EwrSite[]): SearchEntry[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const found = new Map<string, { label: string; basin: string; where: string; target: SearchTarget }>();
	const add = (label: string, basin: string, where: string, target: SearchTarget) => {
		const key = `${label.toLowerCase()}|${target.kind === 'node' ? target.id : `#${target.index}`}`;
		if (!found.has(key)) found.set(key, { label, basin, where, target });
	};
	for (const n of nodes) {
		add(n.label, n.basin, n.label, { kind: 'node', id: n.id });
		for (const s of n.sites) add(s.label, n.basin, n.label, { kind: 'node', id: n.id });
	}
	sites.forEach((s, index) => {
		const n = s.node ? byId.get(s.node) : undefined;
		add(s.label, s.basin, n?.label ?? '', n ? { kind: 'node', id: n.id } : { kind: 'site', index });
	});

	const items = [...found.values()];
	const tally = (key: (e: (typeof items)[number]) => string) => {
		const count = new Map<string, number>();
		for (const e of items) count.set(key(e), (count.get(key(e)) ?? 0) + 1);
		return (e: (typeof items)[number]) => (count.get(key(e)) ?? 0) > 1;
	};
	const repeated = tally((e) => e.label.toLowerCase());
	const repeatedInBasin = tally((e) => `${e.label.toLowerCase()}|${e.basin}`);
	const unique = new Map<string, SearchEntry>();
	for (const e of items) {
		const value = !repeated(e)
			? e.label
			: repeatedInBasin(e)
				? `${e.label} (${[e.basin, e.where].filter(Boolean).join(', ')})`
				: `${e.label} (${e.basin})`;
		if (!unique.has(value)) unique.set(value, { value, label: e.label, target: e.target });
	}
	return [...unique.values()].sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

/** The entry for typed text, ignoring case. A bare repeated label finds its first entry. */
export function findEntry(entries: SearchEntry[], text: string): SearchEntry | null {
	const t = text.trim().toLowerCase();
	if (!t) return null;
	return entries.find((e) => e.value.toLowerCase() === t) ?? entries.find((e) => e.label.toLowerCase() === t) ?? null;
}

/** Bounds of any GeoJSON coordinates array, however deeply nested. */
export function boundsOf(coordinates: unknown[]): Bounds {
	const box: Bounds = [[Infinity, Infinity], [-Infinity, -Infinity]];
	const walk = (c: unknown[]) => {
		if (typeof c[0] === 'number') {
			const [x, y] = c as Position;
			box[0] = [Math.min(box[0][0], x), Math.min(box[0][1], y)];
			box[1] = [Math.max(box[1][0], x), Math.max(box[1][1], y)];
		} else {
			for (const part of c as unknown[][]) walk(part);
		}
	};
	walk(coordinates);
	return box;
}

/** The most of a map's area its open legend may cover and still start open. */
export const LEGEND_SHARE = 0.1;

/** Whether the legend, measured open, is small enough beside the map to start open. */
export const legendStartsOpen = (legend: { width: number; height: number }, view: { width: number; height: number }) =>
	view.width > 0 && view.height > 0 && (legend.width * legend.height) / (view.width * view.height) <= LEGEND_SHARE;

/** A map fit's margin on each side, in pixels, as MapLibre's fitBounds takes it. */
export interface FitPadding {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** The margin every fit keeps. */
export const FIT_MARGIN = 30;
/** Below this, in pixels across or down, a fit beside the legend is not worth it and it is fitted as usual. */
const MIN_FIT = 160;

/** Web Mercator's y for a latitude, in the same units as longitude degrees, so the two can be compared. */
const mercatorY = (lat: number) => (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;

/**
 * The margins a fit to bounds uses so the bounds stay clear of the legend in the map's bottom-left corner.
 * legend is where the legend ends, in pixels from the map's top-left: its right edge and its top. When an
 * even margin already keeps the bounds clear of it, that is used. Otherwise the bounds go beside the legend
 * or above it, whichever draws them larger, unless the map is too small for either.
 */
export function fitPadding(
	bounds: Bounds,
	view: { width: number; height: number },
	legend: { right: number; top: number } | null
): FitPadding {
	const m = FIT_MARGIN;
	const even = { top: m, right: m, bottom: m, left: m };
	if (!legend) return even;
	const [[w, s], [e, n]] = bounds;
	const bw = Math.max(e - w, 1e-9);
	const bh = Math.max(mercatorY(n) - mercatorY(s), 1e-9);
	const scale = (p: FitPadding) => Math.min((view.width - p.left - p.right) / bw, (view.height - p.top - p.bottom) / bh);
	// An even fit centres the bounds: do they reach past the legend's right edge and below its top?
	const k = scale(even);
	if (view.width / 2 - (bw * k) / 2 >= legend.right || view.height / 2 + (bh * k) / 2 <= legend.top) return even;
	const beside = { ...even, left: legend.right + m };
	const above = { ...even, bottom: view.height - legend.top + m };
	const fits = (p: FitPadding) => view.width - p.left - p.right >= MIN_FIT && view.height - p.top - p.bottom >= MIN_FIT;
	const options = [beside, above].filter(fits);
	if (!options.length) return even;
	return options.reduce((best, p) => (scale(p) > scale(best) ? p : best));
}

/** The file the node's view is using, which the popup's pull-down starts on. */
/** Basin extents from the node points, so zooming works whether or not the live layers load. */
export function basinBounds(nodes: EwrNode[]): { name: string; bounds: Bounds }[] {
	const points = new Map<string, Position[]>();
	for (const n of nodes) {
		if (n.lon === null || n.lat === null) continue;
		points.set(n.basin, [...(points.get(n.basin) ?? []), [n.lon, n.lat]]);
	}
	return [...points].map(([name, coords]) => ({ name, bounds: boundsOf(coords) }));
}

export function fileInUse(view: NodeView, files: NodeFile[]): string | undefined {
	return view.method === 'revised' ? files.find((f) => f.kind === 'revised')?.name : view.source?.name;
}

export function fileOption(f: NodeFile): string {
	return `${f.name}${f.ec ? ` (EC ${f.ec})` : ''} - ${KIND_LABEL[f.kind]}`;
}

const INFO_LABEL: [keyof NodeInfo, string][] = [
	['remp', 'REMP/BM site'],
	['ewrSite', 'EWR site ID (Reserve Gazette)'],
	['wqStation', 'WQ monitoring station'],
	['swsaSw', 'SWSA, surface water'],
	['swsaGw', 'SWSA, groundwater']
];

/** The popup's lines for what the RQO node workbook records at a node, in a fixed order, leaving out what it does not record. */
export function infoRows(info: NodeInfo): { label: string; value: string }[] {
	return INFO_LABEL.flatMap(([key, label]) => (info[key] ? [{ label, value: info[key] }] : []));
}
