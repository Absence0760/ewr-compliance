#!/usr/bin/env node
// Ceilings on the shipped app's code, gzip-measured, after `pnpm build` (from the estate's bundle
// budgets: project-water-management's and threkir's check_web_bundle_budget.mjs).
//
// Everything in build/_app is downloaded by someone, and nothing else notices weight. A change that
// pushes a figure over its ceiling fails CI, so growth is a decision rather than an accident. Raising
// a ceiling is a fine outcome: change BUDGET below in the same commit and say in its message what
// grew and why.
//
//   totalCodeKb        every .js, .mjs and .css file in build/_app, summed. Lazy chunks count:
//                      splitting code must not lower it, only removing weight does.
//   largestAppChunkKb  the largest single file that is not one of the libraries below: the pages,
//                      the components, their shared chunks. Catches a heavy dependency landing in
//                      the app's own code.
//   mapKb              MapLibre (src/lib/components/map/maplibre.ts's chunk, its CSS and its worker)
//                      and the PMTiles reader. Loads when a map is drawn.
//   xlsxKb             SheetJS, which loads only when a spreadsheet is read (src/lib/ewr/importFlow.ts).
//
// The libraries must stay lazy, each in a chunk of its own: if one is no longer a dynamic entry of
// the build (a static import has pulled it into a page), the check fails whatever the sizes.
//
// Run:   pnpm build && node tools/check-bundle-budget.mjs   (CI: ci.yml, after the build)
// Tests: tools/check-bundle-budget.test.ts

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Ceilings, in KB gzipped. Measured 2026-11-07: total 706, app chunk 45, map 434, xlsx 155. */
export const BUDGET = { totalCodeKb: 770, largestAppChunkKb: 50, mapKb: 470, xlsxKb: 170 };

/** The lazy libraries: manifest keys (matched by their ending) whose output, with its CSS, is that library's. */
export const LIBRARIES = {
	mapKb: [/^src\/lib\/components\/map\/maplibre\.ts$/, /\/maplibre-gl\/dist\/maplibre-gl-worker\.mjs$/, /\/pmtiles\/dist\/esm\/index\.js$/],
	xlsxKb: [/\/xlsx\/xlsx\.mjs$/]
};

/** The keys that must be dynamic entries (the worker is an asset, not a chunk). */
const MUST_BE_LAZY = [LIBRARIES.mapKb[0], LIBRARIES.mapKb[2], LIBRARIES.xlsxKb[0]];

const CODE = /\.(?:js|mjs|css)$/;
const kb = (/** @type {number} */ bytes) => Math.round((bytes / 1024) * 10) / 10;

/**
 * @typedef {{ file: string, css?: string[], isDynamicEntry?: boolean }} ManifestEntry
 * @param {{ path: string, gzBytes: number }[]} files code files, paths relative to build/
 * @param {Record<string, ManifestEntry>} manifest Vite's client manifest
 */
export function measure(files, manifest) {
	/** @type {string[]} */
	const errors = [];
	const size = new Map(files.map((f) => [f.path, f.gzBytes]));
	/** @type {Set<string>} */
	const libraryFiles = new Set();
	/** @type {Record<string, number>} */
	const libraries = {};
	for (const [metric, keys] of Object.entries(LIBRARIES)) {
		let bytes = 0;
		for (const re of keys) {
			const entries = Object.entries(manifest).filter(([k]) => re.test(k));
			if (!entries.length) {
				errors.push(`no build output for ${re}: has the library moved, or been imported statically?`);
				continue;
			}
			for (const [key, entry] of entries) {
				if (MUST_BE_LAZY.includes(re) && !entry.isDynamicEntry) errors.push(`${key} is no longer loaded lazily, in a chunk of its own`);
				for (const f of [entry.file, ...(entry.css ?? [])]) {
					if (libraryFiles.has(f)) continue;
					libraryFiles.add(f);
					bytes += size.get(f) ?? 0;
				}
			}
		}
		libraries[metric] = kb(bytes);
	}
	const app = files.filter((f) => !libraryFiles.has(f.path)).sort((a, b) => b.gzBytes - a.gzBytes);
	return {
		errors,
		metrics: {
			totalCodeKb: kb(files.reduce((s, f) => s + f.gzBytes, 0)),
			largestAppChunkKb: kb(app[0]?.gzBytes ?? 0),
			...libraries
		},
		largestAppChunk: app[0]?.path ?? null
	};
}

/**
 * Each metric over its ceiling, as a message.
 * @param {Record<string, number>} metrics @param {Record<string, number>} budget
 */
export function overBudget(metrics, budget) {
	return Object.entries(budget)
		.filter(([k, ceiling]) => (metrics[k] ?? 0) > ceiling)
		.map(([k, ceiling]) => `${k} is ${metrics[k]} KB gzipped, over its ceiling of ${ceiling} KB`);
}

/** @param {string} dir */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const app = join(root, 'build/_app');
	const manifestPath = join(root, '.svelte-kit/output/client/.vite/manifest.json');
	if (!existsSync(app) || !existsSync(manifestPath)) {
		console.error('No build to measure: run `pnpm build` first.');
		process.exit(1);
	}
	const files = walk(app)
		.filter((f) => CODE.test(f))
		.map((f) => ({ path: relative(join(root, 'build'), f), gzBytes: gzipSync(readFileSync(f), { level: 9 }).length }));
	const { errors, metrics, largestAppChunk } = measure(files, JSON.parse(readFileSync(manifestPath, 'utf8')));
	const over = overBudget(metrics, BUDGET);
	for (const [k, v] of Object.entries(metrics)) console.log(`${k.padEnd(18)} ${String(v).padStart(7)} KB  (ceiling ${BUDGET[/** @type {keyof typeof BUDGET} */ (k)]})`);
	console.log(`largest app chunk: ${largestAppChunk}`);
	for (const e of [...errors, ...over]) console.error(`::error::${e}`);
	if (errors.length || over.length) {
		console.error('Bundle budget failed. Cut the weight, or raise the ceiling in tools/check-bundle-budget.mjs and say why in the commit.');
		process.exit(1);
	}
	console.log('Bundle budget OK.');
}
