// Builds static/geo/rivers-<wma>.json, the rivers drawn and named on each WMA's map, from the DWS
// 1:500 000 rivers (primary and secondary, each reach with its NAME) on the DWS ArcGIS service.
// Run with `node tools/build-rivers.ts`. Needs network access. The rivers are public domain DWS data
// and are committed (NOTICE.md). The WMA outlines are used only to sort reaches, and are not written.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Feature, FeatureCollection } from 'geojson';
import { getAll, outlineOf, queryUrl, WMA_LAYER } from '../src/lib/components/map/catchments.ts';
import { touches, verticesOf, WMAS } from '../src/lib/components/map/wma.ts';

/** About 50 m: finer than the map needs below zoom 12, and a quarter of the size of the source. */
const OFFSET = 0.0005;
const OUT = new URL('../static/geo/', import.meta.url);

const text = (v: unknown) => String(v ?? '').trim();

/** One reach, reduced to what the map shows: name `n`, Strahler order `s` and flow class `c`. */
function reach(f: Feature): Feature {
	const p = f.properties ?? {};
	return { type: 'Feature', properties: { n: text(p.NAME), s: Number(p.STRAHLER) || 1, c: text(p.CLASS) }, geometry: f.geometry };
}

const rivers = await getAll(queryUrl('Rivers', '1=1', 'NAME,STRAHLER,CLASS', OFFSET, 4));
console.log(`${rivers.features.length} reaches, ${rivers.features.filter((f) => text(f.properties?.NAME)).length} named`);
mkdirSync(OUT, { recursive: true });
// Every outline in one request, at about 400 m: a reach near a boundary may land in both WMAs, which is harmless.
const outlines = await getAll(queryUrl(WMA_LAYER, '1=1', 'WMA_NAME', 0.004, 4));
const placed = new Set<Feature>();
for (const wma of WMAS) {
	const outline = outlineOf({ type: 'FeatureCollection', features: outlines.features.filter((f) => f.properties?.WMA_NAME === wma.service) });
	if (!outline.length) throw new Error(`No outline for ${wma.service} in ${WMA_LAYER}`);
	const [[w, s], [e, n]] = wma.bounds;
	const inBox = (f: Feature) => verticesOf(f.geometry).some(([x, y]) => x >= w && x <= e && y >= s && y <= n);
	const mine = rivers.features.filter((f) => inBox(f) && touches(f, outline));
	for (const f of mine) placed.add(f);
	const fc: FeatureCollection = { type: 'FeatureCollection', features: mine.map(reach) };
	const body = JSON.stringify(fc);
	writeFileSync(new URL(`rivers-${wma.slug}.json`, OUT), body);
	console.log(`${wma.slug}: ${mine.length} reaches, ${(body.length / 1e6).toFixed(2)} MB`);
}
// Reaches in Lesotho or Eswatini, or nowhere, are left out. Say how many, so a change shows.
console.log(`${rivers.features.length - placed.size} reaches in no WMA`);
