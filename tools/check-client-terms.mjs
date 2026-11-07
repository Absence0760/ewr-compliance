#!/usr/bin/env node
// Client material never enters this public repo (CLAUDE.md hard rule 2; SECURITY.md § Public repo
// hygiene). Adapted from project-water-management's scripts/guards/check_client_terms.mjs.
//
// The list of what may not appear (node codes, site and file names, phrases from the brief) is
// itself client material, so it lives in the private repo:
//
//   ../ewr-compliance-private/client-terms.txt   ($EWR_PRIVATE_DIR/client-terms.txt, or $CLIENT_TERMS_FILE)
//
// "../" is beside this checkout or, in a linked git worktree, beside the main checkout: a worktree
// under .claude/worktrees/ has no private repo beside it.
//
// One term per line; `#` starts a comment. Matching ignores case, and a space in a term also matches
// "", "_", "-", or a line break plus comment markers, so "Some River" catches "SomeRiver",
// "some-river" and a name split across a comment line. A term matches only as a whole word (no
// letter or digit on either side).
//
// Without the terms file the guard does nothing (a fresh clone, CI, a fork), so it never blocks
// work; it just can't check. It never prints a matched term or the line's text, only the file, the
// line and the term's number in the list, with any term in the file's path starred out: a CI log or a transcript is as public as the repo.
//
// Run:   node tools/check-client-terms.mjs                 every tracked file and path
//        node tools/check-client-terms.mjs --staged        staged changes (.githooks/pre-commit)
//        node tools/check-client-terms.mjs --message <f>   a commit message (.githooks/commit-msg)
//        node tools/check-client-terms.mjs --history       every ref's messages, diffs and paths
// Tests: tools/check-client-terms.test.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERMS_PATH = '../ewr-compliance-private/client-terms.txt';

/**
 * Where the terms file may be: $CLIENT_TERMS_FILE alone if set; else $EWR_PRIVATE_DIR's, if set;
 * else beside this checkout, then beside the main checkout a linked worktree belongs to (the parent
 * of the shared .git).
 * @param {string} root @param {string | null} commonDir absolute git common dir
 * @param {Record<string, string | undefined>} env
 */
export function termsFileCandidates(root, commonDir, env = {}) {
	if (env.CLIENT_TERMS_FILE) return [env.CLIENT_TERMS_FILE];
	if (env.EWR_PRIVATE_DIR) return [resolve(root, env.EWR_PRIVATE_DIR, 'client-terms.txt')];
	const out = [resolve(root, TERMS_PATH)];
	if (commonDir) out.push(resolve(dirname(commonDir), TERMS_PATH));
	return [...new Set(out)];
}

function gitCommonDir() {
	try {
		return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

/** @param {string} text */
export function parseTerms(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.replace(/#.*$/, '').trim())
		.filter(Boolean);
}

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One case-insensitive, whole-word pattern per term. @param {string[]} terms */
export function compileTerms(terms) {
	return terms.map((t) => {
		const body = t.split(/\s+/).map(escape).join('(?:[\\s_-]|\\n[\\s#/*>-]*)*');
		return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
	});
}

/**
 * Which term matched on which line. The text is never returned.
 * @param {string} text @param {RegExp[]} patterns
 * @returns {{ line: number, term: number }[]}
 */
export function scanText(text, patterns) {
	/** @type {{ line: number, term: number }[]} */
	const out = [];
	patterns.forEach((re, i) => {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) out.push({ line: text.slice(0, m.index).split('\n').length, term: i + 1 });
	});
	return out.sort((a, b) => a.line - b.line || a.term - b.term);
}

/**
 * Added lines of a unified diff, by file and new-file line number.
 * @param {string} diff @returns {Map<string, { line: number, text: string }[]>}
 */
export function addedLines(diff) {
	/** @type {Map<string, { line: number, text: string }[]>} */
	const files = new Map();
	/** @type {string | null} */
	let file = null;
	let line = 0;
	for (const l of diff.split('\n')) {
		if (l.startsWith('+++ ')) {
			file = l === '+++ /dev/null' ? null : l.slice(6);
			if (file && !files.has(file)) files.set(file, []);
		} else if (l.startsWith('@@')) {
			line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
		} else if (file && l.startsWith('+')) {
			files.get(file)?.push({ line, text: l.slice(1) });
			line++;
		} else if (!l.startsWith('-') && !l.startsWith('\\')) {
			line++;
		}
	}
	return files;
}

const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

/**
 * A path with every term in it starred out, so a finding can be located without the report printing
 * the term the path holds. @param {string} path @param {RegExp[]} patterns
 */
export function maskPath(path, patterns) {
	return patterns.reduce((p, re) => p.replace(re, (m) => '*'.repeat(m.length)), path);
}

/** @param {{ file: string, line?: number, term: number }[]} findings @param {string} what */
function report(findings, what) {
	for (const f of findings) console.error(`::error file=${f.file}${f.line ? `,line=${f.line}` : ''}::client term #${f.term} from the terms file`);
	if (findings.length) {
		console.error(`${findings.length} client-term finding(s) in ${what}. Terms are deliberately not printed; see SECURITY.md § Public repo hygiene.`);
		process.exit(1);
	}
	console.log(`Client terms OK (${what}).`);
}

function main() {
	const args = process.argv.slice(2);
	const candidates = termsFileCandidates(ROOT, gitCommonDir(), process.env);
	const termsFile = candidates.find((f) => existsSync(f));
	if (!termsFile) {
		console.log(`No client terms file at ${candidates.join(' or ')}; skipping (SECURITY.md § Public repo hygiene).`);
		return;
	}
	const patterns = compileTerms(parseTerms(readFileSync(termsFile, 'utf8')));
	if (!patterns.length) return console.log('The client terms file is empty; nothing to check.');
	/** @type {{ file: string, line?: number, term: number }[]} */
	const findings = [];
	const push = (/** @type {{ file: string, line?: number, term: number }} */ f) => findings.push({ ...f, file: maskPath(f.file, patterns) });
	const scanPath = (/** @type {string} */ p) => scanText(p, patterns).forEach((f) => push({ file: p, term: f.term }));

	if (args[0] === '--message') {
		const msg = readFileSync(args[1], 'utf8').replace(/^#.*$/gm, '');
		scanText(msg, patterns).forEach((f) => findings.push({ ...f, file: '(commit message)' }));
		return report(findings, 'the commit message');
	}
	if (args[0] === '--staged') {
		for (const p of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) scanPath(p);
		for (const [file, lines] of addedLines(git(['diff', '--cached', '-U0', '--no-color', '--text']))) {
			// Consecutive added lines are joined, so a term split across two lines still matches.
			const text = lines.map((l) => l.text).join('\n');
			for (const f of scanText(text, patterns)) push({ file, line: lines[f.line - 1].line, term: f.term });
		}
		return report(findings, 'staged changes');
	}
	if (args[0] === '--history') {
		for (const f of scanText(git(['log', '--all', '--format=%B']), patterns)) findings.push({ file: '(commit messages, all refs)', term: f.term });
		for (const f of scanText(git(['log', '--all', '-p', '--text', '--format=', '--no-color']), patterns)) findings.push({ file: '(diffs, all refs)', term: f.term });
		for (const p of new Set(git(['log', '--all', '--format=', '--name-only']).split('\n').filter(Boolean))) scanPath(p);
		return report(findings, 'the history of every ref');
	}
	const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
	for (const p of tracked) {
		scanPath(p);
		const full = resolve(ROOT, p);
		if (!existsSync(full)) continue;
		const buf = readFileSync(full);
		if (!buf.includes(0)) scanText(buf.toString('utf8'), patterns).forEach((f) => push({ file: p, ...f }));
	}
	report(findings, `${tracked.length} tracked files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
