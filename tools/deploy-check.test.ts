// The checks tools/deploy.sh makes before an upload, on synthetic listings, and its command line on a
// throwaway build.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBuild, checkFunctions, isSampleIndex, listFiles, MAX_FILE_BYTES, MAX_FILES, summarize } from './deploy-check.mjs';

const SAMPLE = JSON.stringify({ sample: true, nodes: [] });
const REAL = JSON.stringify({ nodes: [] });

const ok = [
	{ path: 'index.html', size: 1000 },
	{ path: '_headers', size: 200 },
	{ path: 'data/index.json', size: 500 }
];

const check = (over: Partial<Parameters<typeof checkBuild>[0]> = {}) =>
	checkBuild({ files: ok, indexJson: SAMPLE, mode: 'sample', hasMiddleware: true, ...over });

describe('checkBuild', () => {
	it('passes a sample build deployed as the sample, and a real one as real', () => {
		expect(check()).toEqual({ errors: [], warnings: [] });
		expect(check({ indexJson: REAL, mode: 'real' })).toEqual({ errors: [], warnings: [] });
	});

	it('refuses data that does not match the mode, both ways', () => {
		expect(check({ mode: 'real' }).errors).toEqual(['The build holds the synthetic sample, not the real data.']);
		expect(check({ indexJson: REAL }).errors).toEqual(['The build holds real data, not the synthetic sample.']);
	});

	it('refuses a build with no data/index.json, or one that is not JSON', () => {
		expect(check({ indexJson: null }).errors).toEqual(['The build has no data/index.json, so the app cannot start.']);
		expect(check({ indexJson: '{' }).errors).toEqual(["The build's data/index.json is not JSON."]);
	});

	it('refuses an unknown mode', () => {
		expect(check({ mode: 'prod' as 'real' }).errors[0]).toMatch(/Unknown mode "prod"/);
	});

	it('refuses when functions/_middleware.ts is missing', () => {
		expect(check({ hasMiddleware: false }).errors[0]).toMatch(/_middleware\.ts is missing/);
	});

	it('refuses a file over 25 MiB, naming it, and allows one at exactly the limit', () => {
		const big = [...ok, { path: 'data/flows-big.json', size: MAX_FILE_BYTES + 1 }];
		expect(check({ files: big }).errors).toEqual([expect.stringContaining('data/flows-big.json is 25.0 MiB')]);
		expect(check({ files: [...ok, { path: 'edge.json', size: MAX_FILE_BYTES }] }).errors).toEqual([]);
	});

	it('refuses more than 20,000 files, and allows exactly 20,000', () => {
		const pad = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f/${i}`, size: 1 }));
		expect(check({ files: [...ok, ...pad(MAX_FILES - ok.length)] }).errors).toEqual([]);
		expect(check({ files: [...ok, ...pad(MAX_FILES - ok.length + 1)] }).errors).toEqual([`${MAX_FILES + 1} files, over Cloudflare Pages' limit of ${MAX_FILES}.`]);
	});

	it('refuses a build carrying the base map', () => {
		expect(check({ files: [...ok, { path: 'tiles/south-africa.pmtiles', size: 10 }] }).errors[0]).toMatch(/tiles\/ folder/);
	});

	it('refuses a _worker.js or _routes.json, which would override functions/', () => {
		expect(check({ files: [...ok, { path: '_worker.js', size: 10 }] }).errors[0]).toMatch(/has _worker\.js/);
		expect(check({ files: [...ok, { path: '_worker.js/index.js', size: 10 }] }).errors[0]).toMatch(/has _worker\.js/);
		expect(check({ files: [...ok, { path: '_routes.json', size: 10 }] }).errors[0]).toMatch(/has _routes\.json/);
	});

	it('only warns when _headers is absent', () => {
		const r = check({ files: ok.filter((f) => f.path !== '_headers') });
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([expect.stringContaining('no _headers file')]);
	});

	it('reports every problem at once', () => {
		const r = checkBuild({ files: [{ path: 'tiles/x', size: MAX_FILE_BYTES + 1 }], indexJson: null, mode: 'real', hasMiddleware: false });
		expect(r.errors).toHaveLength(4);
	});
});

describe('checkFunctions', () => {
	const gate = { routePath: '/', mountPath: '/', method: '', middleware: ['_middleware.ts:onRequest'] };
	const api = { routePath: '/api/me', mountPath: '/api', method: 'GET', module: ['api/me.ts:onRequestGet'] };
	const all = { include: ['/*'], exclude: [] as string[] };

	it('passes a middleware at / that runs on every path', () => {
		expect(checkFunctions({ routes: [api, gate] }, all)).toEqual([]);
	});

	it('refuses functions with no middleware at /', () => {
		expect(checkFunctions({ routes: [api] }, all)).toEqual([expect.stringContaining('no _middleware.ts:onRequest at /')]);
		expect(checkFunctions({ routes: [api, { ...gate, routePath: '/api' }] }, all)).toHaveLength(1);
	});

	it('refuses routes that leave any path out of the functions', () => {
		expect(checkFunctions({ routes: [gate] }, { include: ['/api/*'], exclude: [] })).toEqual(['The functions run only on /api/*, not on every path (/*).']);
		expect(checkFunctions({ routes: [gate] }, { include: ['/*'], exclude: ['/data/*'] })).toEqual([
			'The functions skip /data/*, which would be served without the list check.'
		]);
	});
});

describe('isSampleIndex and summarize', () => {
	it('takes only `sample: true` as the sample', () => {
		expect(isSampleIndex(SAMPLE)).toBe(true);
		expect(isSampleIndex(REAL)).toBe(false);
		expect(isSampleIndex(JSON.stringify({ sample: 'true' }))).toBe(false);
	});

	it('counts files and bytes', () => {
		expect(summarize(ok)).toEqual({ count: 3, bytes: 1700 });
	});
});

describe('the command line', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true });
	});

	function tree(index: string) {
		const root = mkdtempSync(join(tmpdir(), 'ewr-deploy-'));
		dirs.push(root);
		mkdirSync(join(root, 'functions'));
		writeFileSync(join(root, 'functions/_middleware.ts'), '');
		mkdirSync(join(root, 'build/data'), { recursive: true });
		writeFileSync(join(root, 'build/index.html'), 'x');
		writeFileSync(join(root, 'build/data/index.json'), index);
		return root;
	}
	const run = (root: string, mode: string) => {
		const r = spawnSync('node', [join(import.meta.dirname, 'deploy-check.mjs'), join(root, 'build'), mode, root], { encoding: 'utf8' });
		return { status: r.status, out: r.stdout + r.stderr };
	};

	it('lists nested files with forward slashes', () => {
		const root = tree(SAMPLE);
		expect(listFiles(join(root, 'build')).map((f) => f.path).sort()).toEqual(['data/index.json', 'index.html']);
	});

	it('passes a matching build with a summary and the _headers warning', () => {
		const r = run(tree(SAMPLE), 'sample');
		expect(r.status).toBe(0);
		expect(r.out).toContain('Build: 2 files');
		expect(r.out).toContain('Warning: The build has no _headers file');
	});

	it('exits 1 on a mismatch, saying why', () => {
		const r = run(tree(SAMPLE), 'real');
		expect(r.status).toBe(1);
		expect(r.out).toContain('Refused: The build holds the synthetic sample');
	});
});
