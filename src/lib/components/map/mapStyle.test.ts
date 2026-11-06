import { describe, expect, test } from 'vitest';
import { baseStyle, basemapLayerIds, tileUrl } from './mapStyle.ts';

describe('baseStyle', () => {
	test('is a plain background with no tiles URL, and asks for nothing', () => {
		const s = baseStyle(null, null);
		expect(s.sources).toEqual({});
		expect(s.layers.map((l) => l.id)).toEqual(['background']);
	});

	test('credits Protomaps and OpenStreetMap whenever the base map is drawn', () => {
		const s = baseStyle('https://example.org/t.pmtiles', null);
		expect(JSON.stringify(s.sources)).toContain('OpenStreetMap');
	});

	test('fills water polygons only, because a fill closes river lines into false wedges', () => {
		const water = baseStyle('https://example.org/t.pmtiles', null).layers.find((l) => l.id === 'bm-water');
		expect(water).toMatchObject({ filter: ['==', ['geometry-type'], 'Polygon'] });
	});

	test('draws labels only when there are glyphs', () => {
		const url = 'https://example.org/t.pmtiles';
		expect(basemapLayerIds(baseStyle(url, null))).not.toContain('bm-label-places');
		expect(basemapLayerIds(baseStyle(url, 'https://example.org/{fontstack}/{range}.pbf'))).toContain('bm-label-places');
	});
});

describe('tileUrl', () => {
	test('puts a path beside the app, not beside the page, so a WMA page finds the fonts', () => {
		// The app's root, as both maps work it out on a WMA page two folders down.
		const root = new URL('../../', 'http://localhost:7790/wma/sample/').href;
		expect(tileUrl('tiles/fonts/{fontstack}/{range}.pbf', root)).toBe('http://localhost:7790/tiles/fonts/{fontstack}/{range}.pbf');
		expect(tileUrl('tiles/sa.pmtiles', 'https://example.org/ewr/')).toBe('https://example.org/ewr/tiles/sa.pmtiles');
		expect(tileUrl('/tiles/sa.pmtiles', 'https://example.org/ewr')).toBe('https://example.org/ewr/tiles/sa.pmtiles');
	});

	test('keeps a full URL as it is, and gives nothing for an empty setting', () => {
		expect(tileUrl(' https://tiles.example.org/{fontstack}/{range}.pbf ', 'http://localhost/')).toBe('https://tiles.example.org/{fontstack}/{range}.pbf');
		expect(tileUrl('', 'http://localhost/')).toBeNull();
		expect(tileUrl(undefined, 'http://localhost/')).toBeNull();
	});
});
