// The client terms guard (tools/check-client-terms.mjs): its matching, on invented terms, and its
// command line end to end in a throwaway git repo. Synthetic terms only: the real list is private.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines, compileTerms, maskPath, parseTerms, scanText, termsFileCandidates } from './check-client-terms.mjs';

const patterns = compileTerms(parseTerms('# invented client\nMadeup River\nFakenode  # a node\n\n'));

describe('matching', () => {
	it('drops comments and blank lines from the list', () => {
		expect(parseTerms('# c\nMadeup River\n  Fakenode  # node\n\n')).toEqual(['Madeup River', 'Fakenode']);
	});

	it('catches every spelling a rename produces', () => {
		for (const s of ['Madeup River', 'madeup river', 'MadeupRiver', 'madeup-river', 'madeup_river', 'static/madeupriver/x.json', "MadeupRiver's"]) {
			expect(scanText(s, patterns), s).toHaveLength(1);
		}
	});

	it('catches a term split across a comment line break', () => {
		expect(scanText('// plus the Madeup\n// River gauge', patterns)).toEqual([{ line: 1, term: 1 }]);
		expect(scanText('# the Madeup\n# River', patterns)).toEqual([{ line: 1, term: 1 }]);
	});

	it('matches whole words only, with the line and term number of each hit', () => {
		expect(scanText('Fakenodes and unFakenode and Fakenode2', patterns)).toEqual([]);
		expect(scanText('ok\nFakenode!Z17 = 1\nMadeup River, Fakenode', patterns)).toEqual([
			{ line: 2, term: 2 },
			{ line: 3, term: 1 },
			{ line: 3, term: 2 }
		]);
	});

	it('stars every term out of a path', () => {
		expect(maskPath('e2e/madeup-river/fakenode.rul', patterns)).toBe('e2e/************/********.rul');
	});

	it('reads only added lines of a diff, with new-file line numbers', () => {
		const diff = [
			'--- a/a.md',
			'+++ b/a.md',
			'@@ -3,0 +4,2 @@',
			'+first',
			'+second',
			'@@ -10 +12 @@',
			'-old Fakenode',
			'+new',
			'--- a/gone.md',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-Fakenode'
		].join('\n');
		expect(Object.fromEntries(addedLines(diff))).toEqual({
			'a.md': [
				{ line: 4, text: 'first' },
				{ line: 5, text: 'second' },
				{ line: 12, text: 'new' }
			]
		});
	});
});

describe('termsFileCandidates', () => {
	const f = '/ewr-compliance-private/client-terms.txt';

	it('looks beside the checkout, and beside the main checkout from a linked worktree', () => {
		expect(termsFileCandidates('/r/main', '/r/main/.git')).toEqual(['/r' + f]);
		expect(termsFileCandidates('/r/main', null)).toEqual(['/r' + f]);
		expect(termsFileCandidates('/r/main/.claude/worktrees/x', '/r/main/.git')).toEqual(['/r/main/.claude/worktrees' + f, '/r' + f]);
	});

	it('takes CLIENT_TERMS_FILE alone, else EWR_PRIVATE_DIR, the folder pnpm data:private reads', () => {
		expect(termsFileCandidates('/r/main', '/r/main/.git', { CLIENT_TERMS_FILE: '/x/t.txt', EWR_PRIVATE_DIR: '/p' })).toEqual(['/x/t.txt']);
		expect(termsFileCandidates('/r/main', '/r/main/.git', { EWR_PRIVATE_DIR: '../priv' })).toEqual(['/r/priv/client-terms.txt']);
	});
});

describe('the command line', () => {
	const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-client-terms.mjs');
	const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
	delete env.CLIENT_TERMS_FILE;
	delete env.EWR_PRIVATE_DIR;
	let dir = '';
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function repo() {
		dir = mkdtempSync(join(tmpdir(), 'client-terms-'));
		const g = (...args: string[]) =>
			execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, stdio: 'pipe' });
		g('init', '-q', '-b', 'main');
		mkdirSync(join(dir, 'tools'));
		copyFileSync(GUARD, join(dir, 'tools/check-client-terms.mjs'));
		writeFileSync(join(dir, 'terms.txt'), 'Fakenode\n');
		const put = (path: string, text: string) => {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), text);
			g('add', path);
		};
		const run = (args: string[] = [], terms: string | null = join(dir, 'terms.txt')) => {
			const r = spawnSync('node', ['tools/check-client-terms.mjs', ...args], {
				cwd: dir,
				env: terms ? { ...env, CLIENT_TERMS_FILE: terms } : env,
				encoding: 'utf8'
			});
			expect(r.stdout + r.stderr, 'the guard never prints a term').not.toMatch(/fakenode/i);
			return r;
		};
		put('.gitignore', 'terms.txt\n');
		put('README.md', 'synthetic\n');
		g('commit', '-q', '-m', 'init');
		return { g, put, run };
	}

	it('fails a tracked file with a term, naming the file and line but not the term', () => {
		const r = repo();
		r.put('docs/notes.md', 'one\nthe Fakenode site\n');
		const res = r.run();
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('::error file=docs/notes.md,line=2::client term #1');
	});

	it('fails a tracked path with a term, starring the term out of the path it reports', () => {
		const r = repo();
		r.put('e2e/fixtures/fakenode.rul', 'synthetic\n');
		const res = r.run();
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('::error file=e2e/fixtures/********.rul::client term #1');
	});

	it('--staged reads only what is staged', () => {
		const r = repo();
		r.put('a.md', 'clean\nFakenode\n');
		const res = r.run(['--staged']);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('::error file=a.md,line=2::');
		r.g('commit', '-q', '-m', 'x');
		expect(r.run(['--staged']).status).toBe(0);
	});

	it('--message ignores the comment lines git adds', () => {
		const r = repo();
		writeFileSync(join(dir, 'msg'), 'fix: a thing\n# Fakenode in a git comment\n');
		expect(r.run(['--message', 'msg']).status).toBe(0);
		writeFileSync(join(dir, 'msg'), 'fix: the Fakenode thing\n');
		const res = r.run(['--message', 'msg']);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('(commit message)');
	});

	it('--history finds a term a later commit removed', () => {
		const r = repo();
		r.put('a.md', 'Fakenode\n');
		r.g('commit', '-q', '-m', 'add');
		r.put('a.md', 'clean\n');
		r.g('commit', '-q', '-m', 'remove');
		expect(r.run().status).toBe(0);
		expect(r.run(['--history']).status).toBe(1);
	});

	it('does nothing, and passes, without a terms file', () => {
		const r = repo();
		r.put('a.md', 'Fakenode\n');
		const res = r.run([], join(dir, 'missing.txt'));
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('skipping');
	});
});
