// The checks tools/deploy.sh makes before an upload, on synthetic listings, and its command line on a
// throwaway build.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIGNIN_FILES, checkBuild, isSampleIndex, listFiles, summarize } from './deploy-check.mjs';

const SAMPLE = JSON.stringify({ sample: true, nodes: [] });
const REAL = JSON.stringify({ nodes: [] });

const ok = [
	{ path: 'index.html', size: 1000 },
	{ path: 'signin/index.html', size: 200 },
	{ path: 'signin/signin.js', size: 200 },
	{ path: 'signin/next.js', size: 200 },
	{ path: 'signin/signin.css', size: 200 },
	{ path: 'data/index.json', size: 500 }
];

const check = (over: Partial<Parameters<typeof checkBuild>[0]> = {}) => checkBuild({ files: ok, indexJson: SAMPLE, mode: 'sample', ...over });

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

	it('refuses a build carrying the base map', () => {
		expect(check({ files: [...ok, { path: 'tiles/south-africa.pmtiles', size: 10 }] }).errors[0]).toMatch(/tiles\/ folder/);
	});

	it("refuses Cloudflare's _headers file, which S3 would serve as a file", () => {
		expect(check({ files: [...ok, { path: '_headers', size: 10 }] }).errors[0]).toMatch(/_headers file/);
	});

	it('refuses a build without the whole sign-in page, naming what is missing', () => {
		const r = check({ files: ok.filter((f) => f.path !== 'signin/index.html' && f.path !== 'signin/next.js') });
		expect(r.errors).toEqual([expect.stringContaining('no signin/index.html, signin/next.js:')]);
	});

	it('requires what static/signin/ holds', () => {
		const shipped = readdirSync(join(import.meta.dirname, '../static/signin')).map((f) => `signin/${f}`).sort();
		expect([...SIGNIN_FILES].sort()).toEqual(shipped);
	});

	it('takes no size or file-count limit from Cloudflare Pages any more', () => {
		const many = Array.from({ length: 20_001 }, (_, i) => ({ path: `f/${i}`, size: 1 }));
		expect(check({ files: [...ok, ...many, { path: 'data/big.json', size: 26 * 1024 * 1024 }] }).errors).toEqual([]);
	});

	it('reports every problem at once', () => {
		const r = checkBuild({ files: [{ path: 'tiles/x', size: 1 }, { path: '_headers', size: 1 }], indexJson: null, mode: 'real' });
		expect(r.errors).toHaveLength(4);
	});
});

describe('isSampleIndex and summarize', () => {
	it('takes only `sample: true` as the sample', () => {
		expect(isSampleIndex(SAMPLE)).toBe(true);
		expect(isSampleIndex(REAL)).toBe(false);
		expect(isSampleIndex(JSON.stringify({ sample: 'true' }))).toBe(false);
	});

	it('counts files and bytes', () => {
		expect(summarize(ok)).toEqual({ count: 6, bytes: 2300 });
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
		mkdirSync(join(root, 'build/data'), { recursive: true });
		writeFileSync(join(root, 'build/index.html'), 'x');
		writeFileSync(join(root, 'build/data/index.json'), index);
		mkdirSync(join(root, 'build/signin'));
		for (const f of SIGNIN_FILES) writeFileSync(join(root, 'build', f), 'x');
		return root;
	}
	const run = (root: string, mode: string) => {
		const r = spawnSync('node', [join(import.meta.dirname, 'deploy-check.mjs'), join(root, 'build'), mode], { encoding: 'utf8' });
		return { status: r.status, out: r.stdout + r.stderr };
	};

	it('lists nested files with forward slashes', () => {
		const root = tree(SAMPLE);
		expect(listFiles(join(root, 'build')).map((f) => f.path).sort()).toEqual(['data/index.json', 'index.html', ...[...SIGNIN_FILES].sort()]);
	});

	it('passes a matching build with a summary', () => {
		const r = run(tree(SAMPLE), 'sample');
		expect(r.status).toBe(0);
		expect(r.out).toContain('Build: 6 files');
	});

	it('refuses a build with no sign-in page', () => {
		const root = tree(SAMPLE);
		rmSync(join(root, 'build/signin'), { recursive: true });
		const r = run(root, 'sample');
		expect(r.status).toBe(1);
		expect(r.out).toContain('Refused: The build has no signin/index.html');
	});

	it('exits 1 on a mismatch, saying why', () => {
		const r = run(tree(SAMPLE), 'real');
		expect(r.status).toBe(1);
		expect(r.out).toContain('Refused: The build holds the synthetic sample');
	});

	it('exits 2 without a mode', () => {
		const r = spawnSync('node', [join(import.meta.dirname, 'deploy-check.mjs'), 'build'], { encoding: 'utf8' });
		expect(r.status).toBe(2);
	});
});
