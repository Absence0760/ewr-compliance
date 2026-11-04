// The scripts that fill static/data, each run on a throwaway tree laid out like this repo. They find
// their folders from their own path, so a copy works on the copy.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '../../..');
const trees: string[] = [];

function tree(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ewr-'));
	trees.push(dir);
	mkdirSync(join(dir, 'tools'));
	return dir;
}

afterEach(() => {
	for (const dir of trees.splice(0)) rmSync(dir, { recursive: true });
});

const run = (cmd: string, args: string[], env: Record<string, string> = {}) => {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
	return { status: r.status, out: r.stdout + r.stderr };
};

describe('pnpm data:sample', () => {
	const script = (dir: string, ...args: string[]) => run('node', [join(dir, 'tools/sample-data.mjs'), ...args]);

	function sampleTree() {
		const dir = tree();
		mkdirSync(join(dir, 'static'));
		copyFileSync(join(REPO, 'tools/sample-data.mjs'), join(dir, 'tools/sample-data.mjs'));
		cpSync(join(REPO, 'e2e/fixtures/sample-data'), join(dir, 'e2e/fixtures/sample-data'), { recursive: true });
		return dir;
	}

	it('fills a fresh clone, where git has left no static/data at all', () => {
		const dir = sampleTree();
		expect(existsSync(join(dir, 'static/data'))).toBe(false);
		expect(script(dir).status).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, 'static/data/index.json'), 'utf8')).sample).toBe(true);
	});

	it('runs again over the sample', () => {
		const dir = sampleTree();
		script(dir);
		expect(script(dir).status).toBe(0);
	});

	it('refuses to overwrite real data, and leaves it', () => {
		const dir = sampleTree();
		mkdirSync(join(dir, 'static/data'));
		writeFileSync(join(dir, 'static/data/index.json'), '{"nodes":[]}');
		const r = script(dir);
		expect(r.status).toBe(1);
		expect(r.out).toContain('--force');
		expect(readFileSync(join(dir, 'static/data/index.json'), 'utf8')).toBe('{"nodes":[]}');
	});

	it('treats other data files with no index as real', () => {
		const dir = sampleTree();
		mkdirSync(join(dir, 'static/data'));
		writeFileSync(join(dir, 'static/data/ewr-berg.json'), '{}');
		expect(script(dir).status).toBe(1);
		expect(readFileSync(join(dir, 'static/data/ewr-berg.json'), 'utf8')).toBe('{}');
	});

	it('overwrites real data when forced', () => {
		const dir = sampleTree();
		mkdirSync(join(dir, 'static/data'));
		writeFileSync(join(dir, 'static/data/index.json'), '{"nodes":[]}');
		writeFileSync(join(dir, 'static/data/stale.json'), '{}');
		expect(script(dir, '--force').status).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, 'static/data/index.json'), 'utf8')).sample).toBe(true);
		expect(existsSync(join(dir, 'static/data/stale.json'))).toBe(false);
	});
});

describe('pnpm data:private', () => {
	function privateTree() {
		const dir = mkdtempSync(join(tmpdir(), 'ewr-private-'));
		trees.push(dir);
		for (const d of ['static/data', 'tests/unit/nested', 'tests/e2e']) mkdirSync(join(dir, d), { recursive: true });
		writeFileSync(join(dir, 'static/data/index.json'), '{"nodes":[]}');
		writeFileSync(join(dir, 'static/data/map.json'), 'an older copy');
		writeFileSync(join(dir, 'tests/unit/nested/a.test.ts'), 'unit');
		writeFileSync(join(dir, 'tests/e2e/b.spec.ts'), 'spec');
		return dir;
	}

	function publicTree() {
		const dir = tree();
		copyFileSync(join(REPO, 'tools/sync-private.sh'), join(dir, 'tools/sync-private.sh'));
		return dir;
	}

	const sync = (dir: string, source: string) => run('bash', ['-e', join(dir, 'tools/sync-private.sh')], { EWR_PRIVATE_DIR: source });

	it("copies the data and the tests, but not the private repo's old map.json", () => {
		const dir = publicTree();
		mkdirSync(join(dir, 'static/data'), { recursive: true });
		writeFileSync(join(dir, 'static/data/stale.json'), '{}');
		mkdirSync(join(dir, 'src/private'), { recursive: true });
		writeFileSync(join(dir, 'src/private/gone.test.ts'), 'old');
		expect(sync(dir, privateTree()).status).toBe(0);
		expect(readdirSync(join(dir, 'static/data'))).toEqual(['index.json']);
		expect(readFileSync(join(dir, 'src/private/nested/a.test.ts'), 'utf8')).toBe('unit');
		expect(readFileSync(join(dir, 'e2e/tests/private/b.spec.ts'), 'utf8')).toBe('spec');
		expect(existsSync(join(dir, 'src/private/gone.test.ts'))).toBe(false);
	});

	it('uses the sibling folder when no directory is set', () => {
		const parent = mkdtempSync(join(tmpdir(), 'ewr-parent-'));
		trees.push(parent);
		cpSync(privateTree(), join(parent, 'ewr-compliance-private'), { recursive: true });
		const dir = join(parent, 'ewr-compliance');
		cpSync(publicTree(), dir, { recursive: true });
		const { EWR_PRIVATE_DIR: _, ...env } = process.env;
		const r = spawnSync('bash', ['-e', join(dir, 'tools/sync-private.sh')], { encoding: 'utf8', env });
		expect(r.status).toBe(0);
		expect(existsSync(join(dir, 'static/data/index.json'))).toBe(true);
	});

	it('stops with a reason, touching nothing, when the folder is missing or is not the private repo', () => {
		const dir = publicTree();
		mkdirSync(join(dir, 'static/data'), { recursive: true });
		writeFileSync(join(dir, 'static/data/index.json'), 'kept');
		const missing = sync(dir, join(dir, 'no-such-folder'));
		expect(missing.status).toBe(1);
		expect(missing.out).toContain('No private repo');

		const wrong = sync(dir, tree());
		expect(wrong.status).toBe(1);
		expect(wrong.out).toContain('is not the private repo');
		expect(readFileSync(join(dir, 'static/data/index.json'), 'utf8')).toBe('kept');
	});
});

describe('the sample generator', () => {
	it('writes exactly what is committed, so the sample cannot drift from its source', () => {
		const dir = tree();
		mkdirSync(join(dir, 'fixtures'));
		copyFileSync(join(REPO, 'e2e/fixtures/make-sample-data.mjs'), join(dir, 'fixtures/make-sample-data.mjs'));
		expect(run('node', [join(dir, 'fixtures/make-sample-data.mjs')]).status).toBe(0);
		const committed = join(REPO, 'e2e/fixtures/sample-data');
		for (const f of readdirSync(committed)) {
			expect(readFileSync(join(dir, 'fixtures/sample-data', f), 'utf8'), f).toBe(readFileSync(join(committed, f), 'utf8'));
		}
	});
});
