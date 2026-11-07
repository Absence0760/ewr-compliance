// static/_headers, the response headers on Cloudflare Pages, read the way Pages reads it: a path line,
// then indented `Name: value` lines; every rule whose path matches applies, a `*` matches anything
// slashes included, and two values for one header are joined with a comma. See docs/hosting.md § Headers.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILE = readFileSync(new URL('../static/_headers', import.meta.url), 'utf8');

interface Rule {
	path: string;
	headers: [string, string][];
}

function parse(text: string): Rule[] {
	const rules: Rule[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('/')) rules.push({ path: line, headers: [] });
		else {
			const at = line.indexOf(':');
			if (at < 1 || !rules.length) throw new Error(`Not a path or a header: ${line}`);
			rules.at(-1)!.headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
		}
	}
	return rules;
}

const RULES = parse(FILE);

function headersFor(pathname: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rule of RULES) {
		const re = new RegExp(`^${rule.path.split('*').map((s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('.*')}$`);
		if (!re.test(pathname)) continue;
		for (const [name, value] of rule.headers) out[name] = name in out ? `${out[name]}, ${value}` : value;
	}
	return out;
}

/** The address of every page, from src/routes, with a made-up value for each parameter. */
function pages(dir = new URL('routes/', import.meta.url), at = '/'): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name === '+page.svelte') found.push(at);
		if (entry.isDirectory()) {
			const part = entry.name.startsWith('[') ? 'some-value' : entry.name;
			found.push(...pages(new URL(`${entry.name}/`, dir), `${at}${part}/`));
		}
	}
	return found;
}

const NO_CACHE = 'private, no-cache';
const EVERYWHERE = {
	'x-content-type-options': 'nosniff',
	'content-security-policy': "frame-ancestors 'none'",
	'referrer-policy': 'strict-origin-when-cross-origin'
};

describe('static/_headers', () => {
	it('stays within what Pages accepts', () => {
		expect(RULES.length).toBeLessThanOrEqual(100);
		for (const line of FILE.split('\n')) expect(line.length).toBeLessThanOrEqual(2000);
		for (const { path, headers } of RULES) {
			expect(path.split('*').length, path).toBeLessThanOrEqual(2);
			expect(headers.length, path).toBeGreaterThan(0);
		}
		expect(new Set(RULES.map((r) => r.path)).size).toBe(RULES.length);
	});

	it('sends no-cache, privately, for every page', () => {
		const all = [...pages(), '/404.html', '/index.html'];
		expect(all).toEqual(expect.arrayContaining(['/', '/nodes/', '/notes/', '/wma/some-value/']));
		for (const page of all) expect(headersFor(page), page).toEqual({ ...EVERYWHERE, 'cache-control': NO_CACHE });
	});

	it('sends no-cache, privately, for the data', () => {
		for (const file of ['/data/index.json', '/data/sub/flows-x.json'])
			expect(headersFor(file), file).toEqual({ ...EVERYWHERE, 'cache-control': NO_CACHE });
	});

	it('lets the hashed files be kept for a year', () => {
		for (const file of ['/_app/immutable/entry/start.abc123.js', '/_app/immutable/assets/maplibre-gl-worker.abc123.mjs'])
			expect(headersFor(file), file).toEqual({ ...EVERYWHERE, 'cache-control': 'public, max-age=31536000, immutable' });
	});

	it("leaves everything else to Pages' default caching, with the headers for every file", () => {
		for (const file of ['/_app/version.json', '/geo/rivers-x.json', '/tiles/south-africa.pmtiles'])
			expect(headersFor(file), file).toEqual(EVERYWHERE);
	});
});
