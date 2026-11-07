// What the three lockfiles may resolve to. A package resolved without an integrity hash is whatever its
// URL serves on the day of the install, so every resolution must carry one. The only exception is a git
// dependency pinned to a full commit, which is its own hash, and that is allowed by name. It sits in tools/
// because vitest collects tests there; it reads files only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LOCKFILES = ['pnpm-lock.yaml', 'server/pnpm-lock.yaml', 'pipeline/pnpm-lock.yaml'];

/** Git dependencies allowed without an integrity hash, each pinned to a commit. */
const GIT_ALLOWED = ['git@github.com:Absence0760/auth-kit.git'];

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Each `resolution:` in a lockfile, with the package it belongs to. */
export function resolutions(lock: string): { pkg: string; resolution: string }[] {
	const out: { pkg: string; resolution: string }[] = [];
	let pkg = '';
	for (const line of lock.split('\n')) {
		const key = /^ {2}(\S.*):$/.exec(line);
		if (key) pkg = key[1];
		const res = /^ {4}resolution: (\{.*\})$/.exec(line);
		if (res) out.push({ pkg, resolution: res[1] });
	}
	return out;
}

/** Why a resolution is not pinned, or null when it is. */
export function unpinned(resolution: string): string | null {
	if (/\bintegrity: sha512-[A-Za-z0-9+/=]+/.test(resolution)) return null;
	if (/\btype: git\b/.test(resolution)) {
		const repo = /\brepo: ([^,}\s]+)/.exec(resolution)?.[1] ?? '';
		if (!GIT_ALLOWED.includes(repo)) return `git dependency ${repo} is not on the allowlist`;
		if (!/\bcommit: [0-9a-f]{40}\b/.test(resolution)) return `git dependency ${repo} is not pinned to a full commit`;
		return null;
	}
	return 'no integrity hash';
}

describe('lockfile integrity', () => {
	for (const file of LOCKFILES) {
		it(`${file} pins every package by hash`, () => {
			const all = resolutions(read(file));
			expect(all.length).toBeGreaterThan(0);
			const bad = all.flatMap(({ pkg, resolution }) => {
				const why = unpinned(resolution);
				return why ? [`${pkg}: ${why}`] : [];
			});
			expect(bad).toEqual([]);
		});
	}

	it('refuses a tarball URL with no hash, as the SheetJS CDN pin was', () => {
		expect(unpinned('{tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}')).toBe('no integrity hash');
		expect(unpinned('{integrity: sha512-abc=, tarball: file:vendor/x.tgz}')).toBeNull();
	});

	it('allows a git dependency only by name and full commit', () => {
		const ok = '{commit: 048e5165a62bac6bf7c86ec6d65394d76a6831c8, repo: git@github.com:Absence0760/auth-kit.git, type: git}';
		expect(unpinned(ok)).toBeNull();
		expect(unpinned(ok.replace('auth-kit', 'other'))).toMatch(/not on the allowlist/);
		expect(unpinned(ok.replace('048e5165a62bac6bf7c86ec6d65394d76a6831c8', 'v0.1.2'))).toMatch(/not pinned to a full commit/);
	});

	it('finds each resolution with its package', () => {
		const lock = 'packages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-x=}\n\n  b@2.0.0:\n    resolution: {tarball: https://x}\n';
		expect(resolutions(lock)).toEqual([
			{ pkg: 'a@1.0.0', resolution: '{integrity: sha512-x=}' },
			{ pkg: 'b@2.0.0', resolution: '{tarball: https://x}' }
		]);
	});
});

describe('vendored SheetJS', () => {
	// SheetJS publishes no checksum for its CDN tarballs. This one was downloaded once, on 2026-11-07, and
	// matched file for file the copy the app had been installing from the CDN. Its SHA-256 is recorded here
	// so a changed file is a failing test and not only a changed lockfile line.
	const TGZ = 'vendor/xlsx-0.20.3.tgz';
	const SHA256 = '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8';
	const bytes = readFileSync(new URL(`../${TGZ}`, import.meta.url));

	it('is the file downloaded from cdn.sheetjs.com', () => {
		expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256);
	});

	it('is the file the lockfile records', () => {
		const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
		expect(read('pnpm-lock.yaml')).toContain(`xlsx@file:${TGZ}:\n    resolution: {integrity: ${integrity}, tarball: file:${TGZ}}`);
	});

	it('is what package.json depends on', () => {
		expect(JSON.parse(read('package.json')).dependencies.xlsx).toBe(`file:${TGZ}`);
	});
});

describe('the root workspace', () => {
	it("is the app alone, so `pnpm -r` here never touches server/'s or pipeline/'s lockfiles", () => {
		const yaml = read('pnpm-workspace.yaml');
		const packages = yaml.split(/^packages:\s*$/m)[1]?.match(/^\s+-\s*'([^']*)'\s*$/gm)?.map((l) => l.replace(/^\s+-\s*'|'\s*$/g, ''));
		expect(packages).toEqual(['.']);
	});
});

describe('the release-age floor', () => {
	it("holds every install to dependabot.yml's cooldown, so no hand install locks in a release younger than it", () => {
		const days = Number(/default-days:\s*(\d+)/.exec(read('.github/dependabot.yml'))?.[1]);
		expect(days).toBeGreaterThan(0);
		for (const file of ['pnpm-workspace.yaml', 'server/pnpm-workspace.yaml', 'pipeline/pnpm-workspace.yaml']) {
			expect(Number(/^minimumReleaseAge:\s*(\d+)\s*$/m.exec(read(file))?.[1]), file).toBe(days * 24 * 60);
		}
	});
});
