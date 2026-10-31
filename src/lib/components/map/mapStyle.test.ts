import { describe, expect, test } from 'vitest';
import { baseStyle, basemapLayerIds } from './mapStyle.ts';

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
