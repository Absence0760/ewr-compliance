import { describe, expect, it } from 'vitest';
import { ARCGIS_ORIGINS, connectSrc } from './csp.ts';

describe('connectSrc', () => {
	it('is the site and the two ArcGIS services, and no scheme that would let anything else through', () => {
		const src = connectSrc({});
		expect(src).toEqual(['self', 'https://services3.arcgis.com', 'https://services8.arcgis.com']);
		expect(src).not.toContain('https:');
		expect(src).not.toContain('http:');
	});

	it('matches the services the map calls', async () => {
		const { readFileSync } = await import('node:fs');
		const catchments = readFileSync(new URL('lib/components/map/catchments.ts', import.meta.url), 'utf8');
		const called = [...catchments.matchAll(/'(https:\/\/[^/']+)\//g)].map((m) => m[1]);
		expect(new Set(called)).toEqual(new Set(ARCGIS_ORIGINS));
	});

	it('adds the base map host once when its files are on another site', () => {
		const src = connectSrc({ VITE_TILES_URL: 'https://tiles.example.test/za.pmtiles', VITE_TILES_GLYPHS_URL: ' https://tiles.example.test/fonts/{fontstack}/{range}.pbf ' });
		expect(src).toEqual([...connectSrc({}), 'https://tiles.example.test']);
	});

	it('adds nothing for a base map on the site itself, or one over plain http', () => {
		expect(connectSrc({ VITE_TILES_URL: 'tiles/za.pmtiles', VITE_TILES_GLYPHS_URL: 'http://tiles.example.test/f/{fontstack}/{range}.pbf' })).toEqual(connectSrc({}));
	});
});
