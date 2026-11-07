#!/usr/bin/env node
// The Claude agents, commands and skills stay true to this repo (from project-water-management's
// scripts/guards/check_claude_tooling.mjs).
//
// `.claude/` was adapted from sibling projects' scaffolding, and nothing failed when an agent cited a
// path this repo doesn't have or kept another project's placeholder: every /check ran it regardless.
// This guard asserts that:
//
//   1. every agent (.claude/agents/**/*.md), command (.claude/commands/**/*.md) and skill
//      (.claude/skills/*/SKILL.md) opens with a frontmatter block that has a `description:`, and
//      every agent a `name:` equal to its file name and unique across the tree (Claude Code finds
//      agents by that name, not by path);
//   2. no template placeholder survives (`<CMS>`, `the migrations directory`, …);
//   3. every repo path that one of them, `.claude/README.md` or `CLAUDE.md` cites in backticks exists.
//      A token with a placeholder, a glob or a space in it is a pattern, not a citation, and is
//      skipped, as are generated and ignored paths (static/data, build, reviews).
//
// Run:   node tools/check-claude-tooling.mjs   (CI: ci.yml, job `claude-tooling`)
// Tests: tools/check-claude-tooling.test.ts

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ file: string, line?: number, rule: string }} Finding */

/** Template leftovers: text that only makes sense before a project adapts the file. */
export const PLACEHOLDERS = [
	/<payment-processor>/i,
	/<CMS>/,
	/<cms-client>/i,
	/<email-service>/i,
	/<aws-region>/i,
	/<backend-framework>/i,
	/<project-name>/i,
	/the migrations directory/i,
	/your migration runner/i,
	/the backend types file/i,
	/app\.current_org_id/,
	/\btenantQuery\b/
];

/** What a backticked token must start with to count as a repo path. */
const PATH_ROOTS =
	/^(?:src|e2e|docs|tools|bin|infra|server|pipeline|static|vendor|\.github|\.claude)\/|^(?:CLAUDE\.md|README\.md|SECURITY\.md|NOTICE\.md|LICENSE|package\.json|pnpm-lock\.yaml|vite\.config\.ts|tsconfig\.json|\.gitignore|\.gitattributes|\.editorconfig|\.pre-commit-config\.yaml)$/;
/** A token with any of these is a pattern or an example, not a citation. */
const PATTERN = /[<>*{}$…\[\]]|\s|\.\.\.|\bX\b/;
/** Generated, ignored or throwaway paths an agent may rightly name though they are absent. */
const NOT_TRACKED =
	/^(?:static\/data|static\/tiles|build|\.claude\/reviews|\.claude\/worktrees|src\/private|e2e\/zz-[^/]*|e2e\/test-results|e2e\/playwright-report|test-results|server\/dist|pipeline\/dist|server\/node_modules|pipeline\/node_modules)(?:\/|$)/;

/**
 * @param {string} text
 * @returns {{ fields: Map<string, string> } | null}
 */
export function parseFrontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
	if (!m) return null;
	const fields = new Map();
	for (const line of m[1].split('\n')) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) fields.set(kv[1], kv[2].trim());
	}
	return { fields };
}

/**
 * Backticked tokens that look like repo paths, with their line numbers. `file:12`, `file § Heading`
 * and a trailing `/` are trimmed to the path.
 * @param {string} text
 */
export function citedPaths(text) {
	/** @type {{ path: string, line: number }[]} */
	const out = [];
	text.split('\n').forEach((lineText, i) => {
		for (const [, raw] of lineText.matchAll(/`([^`\n]+)`/g)) {
			let token = raw.trim().replace(/\s+§.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
			if (PATTERN.test(token) || !PATH_ROOTS.test(token)) continue;
			token = token.replace(/\/$/, '');
			if (NOT_TRACKED.test(token)) continue;
			out.push({ path: token, line: i + 1 });
		}
	});
	return out;
}

/**
 * @param {string} file repo-relative
 * @param {string} text
 * @param {'agent' | 'command' | 'doc'} kind
 * @param {(path: string) => boolean} exists
 * @returns {Finding[]}
 */
export function checkFile(file, text, kind, exists) {
	/** @type {Finding[]} */
	const out = [];
	if (kind !== 'doc') {
		const fm = parseFrontmatter(text);
		if (!fm) {
			out.push({ file, line: 1, rule: 'no frontmatter block (--- … ---) at the top' });
		} else {
			if (!fm.fields.get('description')) out.push({ file, line: 1, rule: 'frontmatter has no description' });
			if (kind === 'agent') {
				const want = basename(file, '.md');
				const name = fm.fields.get('name');
				if (!name) out.push({ file, line: 1, rule: 'agent frontmatter has no name' });
				else if (name !== want) out.push({ file, line: 1, rule: `agent name "${name}" does not match its file name "${want}"` });
			}
		}
	}
	text.split('\n').forEach((lineText, i) => {
		for (const re of PLACEHOLDERS) {
			if (re.test(lineText)) out.push({ file, line: i + 1, rule: `template placeholder ${re} was never replaced with this repo's real name` });
		}
	});
	for (const { path, line } of citedPaths(text)) {
		if (!exists(path)) out.push({ file, line, rule: `cites \`${path}\`, which does not exist` });
	}
	return out;
}

/** @param {string} dir absolute */
function markdownUnder(dir) {
	/** @type {string[]} */
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
		else if (entry.endsWith('.md')) out.push(full);
	}
	return out;
}

/**
 * @param {string} root absolute repo root
 * @returns {Finding[]}
 */
export function checkRepo(root) {
	const exists = (/** @type {string} */ p) => existsSync(join(root, p));
	/** @type {Finding[]} */
	const out = [];
	/** @type {Map<string, string>} */
	const names = new Map();
	for (const full of markdownUnder(join(root, '.claude/agents'))) {
		const file = relative(root, full);
		const kind = basename(file) === 'README.md' ? 'doc' : 'agent';
		const text = readFileSync(full, 'utf8');
		out.push(...checkFile(file, text, kind, exists));
		if (kind === 'agent') {
			const name = parseFrontmatter(text)?.fields.get('name');
			if (name && names.has(name)) out.push({ file, line: 1, rule: `agent name "${name}" is also used by ${names.get(name)}` });
			if (name) names.set(name, file);
		}
	}
	for (const full of markdownUnder(join(root, '.claude/commands'))) {
		const file = relative(root, full);
		out.push(...checkFile(file, readFileSync(full, 'utf8'), basename(file) === 'README.md' ? 'doc' : 'command', exists));
	}
	for (const full of markdownUnder(join(root, '.claude/skills'))) {
		const file = relative(root, full);
		out.push(...checkFile(file, readFileSync(full, 'utf8'), basename(file) === 'SKILL.md' ? 'command' : 'doc', exists));
	}
	for (const file of ['.claude/README.md', '.claude/personas/README.md', 'CLAUDE.md']) {
		if (exists(file)) out.push(...checkFile(file, readFileSync(join(root, file), 'utf8'), 'doc', exists));
	}
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const findings = checkRepo(root);
	for (const f of findings) console.error(`${f.file}${f.line ? `:${f.line}` : ''}: ${f.rule}`);
	if (findings.length) {
		console.error(`\n${findings.length} problem(s) in the Claude tooling. Fix the agent or command, not this guard.`);
		process.exit(1);
	}
	console.log('Claude tooling OK.');
}
