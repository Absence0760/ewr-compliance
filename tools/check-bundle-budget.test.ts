// tools/check-bundle-budget.mjs, on a synthetic build listing and manifest.
import { describe, expect, it } from 'vitest';
import { BUDGET, measure, overBudget } from './check-bundle-budget.mjs';

const K = 1024;
const files = [
	{ path: '_app/immutable/nodes/1.js', gzBytes: 30 * K },
	{ path: '_app/immutable/chunks/app.js', gzBytes: 10 * K },
	{ path: '_app/immutable/chunks/map.js', gzBytes: 200 * K },
	{ path: '_app/immutable/assets/maplibre.css', gzBytes: 10 * K },
	{ path: '_app/immutable/assets/maplibre-gl-worker.mjs', gzBytes: 100 * K },
	{ path: '_app/immutable/chunks/pmtiles.js', gzBytes: 5 * K },
	{ path: '_app/immutable/chunks/xlsx.js', gzBytes: 150 * K }
];
const manifest = () => ({
	'src/routes/+page.svelte': { file: '_app/immutable/nodes/1.js', isEntry: true },
	'src/lib/components/map/maplibre.ts': { file: '_app/immutable/chunks/map.js', css: ['_app/immutable/assets/maplibre.css'], isDynamicEntry: true },
	'node_modules/.pnpm/maplibre-gl@6/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs': { file: '_app/immutable/assets/maplibre-gl-worker.mjs' },
	'node_modules/.pnpm/pmtiles@4/node_modules/pmtiles/dist/esm/index.js': { file: '_app/immutable/chunks/pmtiles.js', isDynamicEntry: true },
	'node_modules/.pnpm/xlsx@file/node_modules/xlsx/xlsx.mjs': { file: '_app/immutable/chunks/xlsx.js', isDynamicEntry: true }
});

describe('check-bundle-budget', () => {
	it('splits the libraries from the app code, and counts everything in the total', () => {
		expect(measure(files, manifest())).toEqual({
			errors: [],
			metrics: { totalCodeKb: 505, largestAppChunkKb: 30, mapKb: 315, xlsxKb: 150 },
			largestAppChunk: '_app/immutable/nodes/1.js'
		});
	});

	it('fails a library that is no longer lazy, or that the build no longer has', () => {
		const m: Record<string, { file: string; isDynamicEntry?: boolean }> = manifest();
		m['node_modules/.pnpm/xlsx@file/node_modules/xlsx/xlsx.mjs'].isDynamicEntry = false;
		delete m['node_modules/.pnpm/pmtiles@4/node_modules/pmtiles/dist/esm/index.js'];
		const { errors } = measure(files, m);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toMatch(/pmtiles.*has the library moved/);
		expect(errors[1]).toMatch(/xlsx\.mjs is no longer loaded lazily/);
	});

	it('names each figure over its ceiling, and passes one at it', () => {
		expect(overBudget({ totalCodeKb: BUDGET.totalCodeKb, largestAppChunkKb: BUDGET.largestAppChunkKb + 0.1 }, BUDGET)).toEqual([
			`largestAppChunkKb is ${BUDGET.largestAppChunkKb + 0.1} KB gzipped, over its ceiling of ${BUDGET.largestAppChunkKb} KB`
		]);
	});
});
