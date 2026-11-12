// The checks tools/deploy.sh makes before an upload, on synthetic listings, and its command line on a
// throwaway build.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIGNIN_FILES, checkBuild, checkSources, isSampleIndex, listFiles, summarize } from './deploy-check.mjs';

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

	it('refuses any other file under signin/, which is served to anyone', () => {
		const r = check({ files: [...ok, { path: 'signin/data.json', size: 10 }, { path: 'signin/x/index.json', size: 10 }] });
		expect(r.errors).toEqual([expect.stringMatching(/^The build has signin\/data\.json, signin\/x\/index\.json under signin\/, which is served to anyone without signing in\./)]);
		expect(check({ files: [...ok, { path: 'signinx/a.js', size: 1 }] }).errors).toEqual([]);
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

describe('checkSources', () => {
	const SHA = 'a'.repeat(40);
	const clean = { fetched: true, dirty: false, head: 'b'.repeat(40), upstream: 'origin/main', upstreamSha: 'b'.repeat(40), ahead: 0, behind: 0 };
	type Sources = Parameters<typeof checkSources>[0];
	const sources = (over: Partial<Sources> = {}): Sources => ({
		mode: 'real',
		dryRun: false,
		allowDirty: false,
		skipCiCheck: false,
		sha: SHA,
		ci: 'success',
		private: clean,
		...over
	});

	it('passes a green commit and a private repo level with its upstream, printing both', () => {
		const r = checkSources(sources());
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.lines).toEqual(['CI gate: success', 'Private: bbbbbbbbbbbb, upstream origin/main at bbbbbbbbbbbb']);
	});

	it('refuses a commit whose CI gate has not passed, or could not be asked', () => {
		for (const [ci, why] of [['failure', 'has failed'], ['pending', 'has not finished'], ['none', 'has not run'], ['unknown', 'could not be checked']] as const) {
			expect(checkSources(sources({ ci })).errors).toEqual([expect.stringContaining(`CI gate on origin/main (aaaaaaaaaaaa) ${why}`)]);
			expect(checkSources(sources({ ci, mode: 'sample', private: null })).errors).toHaveLength(1);
		}
	});

	it('publishes past a red CI gate with --skip-ci-check, saying so', () => {
		const r = checkSources(sources({ ci: 'failure', skipCiCheck: true }));
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([expect.stringContaining('is failure, published anyway (--skip-ci-check)')]);
	});

	it('refuses a private repo that is dirty, unpushed, behind, unfetched or without an upstream', () => {
		const cases: [Partial<typeof clean>, string][] = [
			[{ dirty: true }, 'it has uncommitted changes'],
			[{ ahead: 2 }, 'it is 2 commits ahead of origin/main, not pushed'],
			[{ behind: 1 }, 'it is 1 commit behind origin/main'],
			[{ fetched: false }, 'its upstream could not be fetched'],
			[{ upstream: null, upstreamSha: null }, 'its branch has no upstream']
		];
		for (const [over, why] of cases) {
			const r = checkSources(sources({ private: { ...clean, ...over } }));
			expect(r.errors).toEqual([expect.stringContaining(why)]);
			expect(r.errors[0]).toMatch(/pass --allow-dirty\.$/);
		}
		expect(checkSources(sources({ private: null })).errors).toEqual(['The private repo could not be read.']);
	});

	it('publishes a dirty private repo with --allow-dirty, saying so', () => {
		const r = checkSources(sources({ allowDirty: true, private: { ...clean, dirty: true, ahead: 1 } }));
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([expect.stringContaining('Published as it stands (--allow-dirty)')]);
		expect(r.lines[1]).toBe('Private: bbbbbbbbbbbb, upstream origin/main at bbbbbbbbbbbb (1 ahead, 0 behind), with uncommitted changes');
	});

	it("refuses when this checkout's tools/ is not origin/main's, for the sample too, and not past --allow-dirty", () => {
		for (const over of [{}, { mode: 'sample' as const, private: null }, { allowDirty: true }]) {
			const r = checkSources(sources({ ...over, toolsMatch: false }));
			expect(r.errors).toEqual([expect.stringContaining("This checkout's tools/ is not origin/main's (aaaaaaaaaaaa)")]);
		}
		expect(checkSources(sources({ toolsMatch: true })).errors).toEqual([]);
		const dry = checkSources(sources({ dryRun: true, toolsMatch: false }));
		expect(dry.errors).toEqual([]);
		expect(dry.warnings).toEqual([expect.stringMatching(/^a real run would refuse: This checkout's tools\//)]);
	});

	it('ignores the private repo for the sample', () => {
		expect(checkSources(sources({ mode: 'sample', private: null }))).toEqual({ errors: [], warnings: [], lines: ['CI gate: success'] });
	});

	it('refuses nothing in a dry run, and reports what a real run would refuse', () => {
		const r = checkSources(sources({ dryRun: true, ci: 'unknown', private: { ...clean, dirty: true } }));
		expect(r.errors).toEqual([]);
		expect(r.warnings).toHaveLength(2);
		expect(r.warnings.every((w) => w.startsWith('a real run would refuse: '))).toBe(true);
	});

	it('runs from the command line, exiting 1 on a refusal', () => {
		const cli = (s: Sources) => spawnSync('node', [join(import.meta.dirname, 'deploy-check.mjs'), 'sources', JSON.stringify(s)], { encoding: 'utf8' });
		const ok = cli(sources());
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain('  CI gate: success');
		const bad = cli(sources({ private: { ...clean, dirty: true } }));
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain('Refused: The private repo is not what its upstream holds: it has uncommitted changes.');
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
