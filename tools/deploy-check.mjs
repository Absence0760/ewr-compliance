// The checks `tools/deploy.sh` runs on a build before it goes up to Cloudflare Pages. The rules are
// pure functions of a file listing, so they are tested without a build; the command line at the end
// walks a real one.
//
//   node tools/deploy-check.mjs <build dir> <sample|real> <checkout root>
//   node tools/deploy-check.mjs functions <config.json> <routes.json>
//
// The second takes the files `wrangler pages functions build --output-config-path --output-routes-path`
// writes. Each prints a summary and any warnings, and exits 1, saying why, on any error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cloudflare Pages' limits: docs/hosting.md § Cost.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;

const MiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// The sample's index.json carries `sample: true`, and real data does not. The same test as
// tools/sample-data.mjs and e2e/playwright.config.ts make.
export function isSampleIndex(text) {
	return JSON.parse(text).sample === true;
}

export function summarize(files) {
	return { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/**
 * @param {object} build
 * @param {{ path: string, size: number }[]} build.files every file in the build, paths relative to it with `/`
 * @param {string | null} build.indexJson the text of the build's data/index.json, or null when it has none
 * @param {'sample' | 'real'} build.mode the data the deploy is meant to publish
 * @param {boolean} build.hasMiddleware whether functions/_middleware.ts is in the checkout deployed from
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkBuild({ files, indexJson, mode, hasMiddleware }) {
	const errors = [];
	const warnings = [];

	if (mode !== 'sample' && mode !== 'real') errors.push(`Unknown mode "${mode}": sample or real.`);
	if (!hasMiddleware) {
		errors.push('functions/_middleware.ts is missing. Without it the site has no list check, and anyone who completes Access\'s code gets in.');
	}

	if (files.length > MAX_FILES) errors.push(`${files.length} files, over Cloudflare Pages' limit of ${MAX_FILES}.`);
	for (const f of files) {
		if (f.size > MAX_FILE_BYTES) errors.push(`${f.path} is ${MiB(f.size)}, over Cloudflare Pages' limit of ${MiB(MAX_FILE_BYTES)} a file.`);
	}

	// Either would replace what wrangler makes of functions/: a _worker.js is deployed in its place, and
	// a _routes.json decides which paths the middleware runs on.
	for (const name of ['_worker.js', '_routes.json']) {
		if (files.some((f) => f.path === name || f.path.startsWith(`${name}/`))) {
			errors.push(`The build has ${name}, which would override functions/ and could leave paths without the list check.`);
		}
	}

	if (files.some((f) => f.path.startsWith('tiles/'))) {
		errors.push('The build has a tiles/ folder. The base map is not deployed: build with VITE_TILES_URL and VITE_TILES_GLYPHS_URL empty and no static/tiles.');
	}

	if (indexJson === null) {
		errors.push('The build has no data/index.json, so the app cannot start.');
	} else {
		let sample;
		try {
			sample = isSampleIndex(indexJson);
		} catch {
			errors.push('The build\'s data/index.json is not JSON.');
		}
		if (sample === true && mode === 'real') errors.push('The build holds the synthetic sample, not the real data.');
		if (sample === false && mode === 'sample') errors.push('The build holds real data, not the synthetic sample.');
	}

	if (!files.some((f) => f.path === '_headers')) warnings.push('The build has no _headers file, so the host sets no headers of its own: docs/hosting.md § Headers.');

	return { errors, warnings };
}

/**
 * What `wrangler pages functions build` made of functions/, which is what `pages deploy` uploads.
 * @param {{ routes: { routePath: string, middleware?: string[] }[] }} config its --output-config-path
 * @param {{ include: string[], exclude: string[] }} routes its --output-routes-path, the _routes.json
 * @returns {string[]} errors
 */
export function checkFunctions(config, routes) {
	const errors = [];
	const gate = config.routes.some((r) => r.routePath === '/' && (r.middleware ?? []).includes('_middleware.ts:onRequest'));
	if (!gate) errors.push('The compiled functions have no _middleware.ts:onRequest at /, so no request would be checked against the list.');
	if (!routes.include.includes('/*')) errors.push(`The functions run only on ${routes.include.join(', ') || 'nothing'}, not on every path (/*).`);
	if (routes.exclude.length) errors.push(`The functions skip ${routes.exclude.join(', ')}, which would be served without the list check.`);
	return errors;
}

export function listFiles(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push({ path: relative(dir, p).split(sep).join('/'), size: statSync(p).size });
		}
	};
	walk(dir);
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'functions') {
	const [config, routes] = process.argv.slice(3).map((p) => JSON.parse(readFileSync(p, 'utf8')));
	const errors = checkFunctions(config, routes);
	for (const e of errors) console.error(`Refused: ${e}`);
	if (!errors.length) console.log('Functions: _middleware runs on every path.');
	process.exit(errors.length ? 1 : 0);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [buildDir, mode, root] = process.argv.slice(2);
	if (!buildDir || !mode || !root) {
		console.error('Usage: node tools/deploy-check.mjs <build dir> <sample|real> <checkout root>');
		process.exit(2);
	}
	if (!existsSync(buildDir)) {
		console.error(`No build at ${buildDir}.`);
		process.exit(1);
	}
	const files = listFiles(buildDir);
	const index = join(buildDir, 'data/index.json');
	const { errors, warnings } = checkBuild({
		files,
		indexJson: existsSync(index) ? readFileSync(index, 'utf8') : null,
		mode,
		hasMiddleware: existsSync(join(root, 'functions/_middleware.ts'))
	});
	const { count, bytes } = summarize(files);
	console.log(`Build: ${count} files, ${MiB(bytes)}, ${mode} data.`);
	for (const w of warnings) console.warn(`Warning: ${w}`);
	for (const e of errors) console.error(`Refused: ${e}`);
	process.exit(errors.length ? 1 : 0);
}
