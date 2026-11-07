// The checks `tools/deploy.sh` runs on a build before it goes up to the site bucket. The rules are
// pure functions of a file listing, so they are tested without a build; the command line at the end
// walks a real one.
//
//   node tools/deploy-check.mjs <build dir> <sample|real>
//   node tools/deploy-check.mjs sources '<JSON>'   what checkSources judges of the commit and the private repo
//
// It prints a summary and any warnings, and exits 1, saying why, on any error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// The sample's index.json carries `sample: true`, and real data does not. The same test as
// tools/sample-data.mjs and e2e/playwright.config.ts make.
export function isSampleIndex(text) {
	return JSON.parse(text).sample === true;
}

/** The sign-in page: served unsigned, so it is self-contained (static/signin/). */
export const SIGNIN_FILES = ['signin/index.html', 'signin/signin.js', 'signin/next.js', 'signin/signin.css'];

export function summarize(files) {
	return { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/**
 * @param {object} build
 * @param {{ path: string, size: number }[]} build.files every file in the build, paths relative to it with `/`
 * @param {string | null} build.indexJson the text of the build's data/index.json, or null when it has none
 * @param {'sample' | 'real'} build.mode the data the deploy is meant to publish
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkBuild({ files, indexJson, mode }) {
	const errors = [];
	const warnings = [];

	if (mode !== 'sample' && mode !== 'real') errors.push(`Unknown mode "${mode}": sample or real.`);

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

	// Cloudflare Pages' header file means nothing to S3, and would be served as a file.
	if (files.some((f) => f.path === '_headers')) errors.push('The build has a _headers file. Headers come from the CloudFront policy (infra/security_headers.tf): remove static/_headers.');

	// The edge function sends everyone not signed in to /signin/ (infra/edge_functions.tf), and
	// CloudFront shows its page for any 403. Without it nobody can sign in, or reach anything.
	const missing = SIGNIN_FILES.filter((p) => !files.some((f) => f.path === p));
	if (missing.length) errors.push(`The build has no ${missing.join(', ')}: the sign-in page (static/signin/) must go up with the site, or nobody can sign in.`);

	// Everything under signin/ is served without signed cookies, to anyone. Only the page's own files
	// may be there, so nothing else in the build can be published by being put in that folder.
	const extra = files.filter((f) => f.path.startsWith('signin/') && !SIGNIN_FILES.includes(f.path)).map((f) => f.path);
	if (extra.length) errors.push(`The build has ${extra.join(', ')} under signin/, which is served to anyone without signing in. Only ${SIGNIN_FILES.join(', ')} may be there.`);

	return { errors, warnings };
}

/**
 * What tools/deploy.sh finds out about its sources before it builds, judged. A real deploy publishes the
 * private repo's HEAD, so that must be exactly what its upstream holds: nothing uncommitted, unpushed or
 * behind. Either deploy publishes origin/main, so CI's `CI gate` must have passed on that commit. A dry
 * run reports what a real run would refuse, as warnings, and refuses nothing.
 *
 * @param {object} s
 * @param {'sample' | 'real'} s.mode
 * @param {boolean} s.dryRun
 * @param {boolean} s.allowDirty `--allow-dirty`: publish the private repo as it stands
 * @param {boolean} s.skipCiCheck `--skip-ci-check`: publish origin/main whatever CI said
 * @param {string} s.sha origin/main's commit
 * @param {'success' | 'failure' | 'pending' | 'none' | 'unknown'} s.ci `CI gate` on that commit;
 *   unknown when it could not be asked (no gh, no network)
 * @param {{ fetched: boolean, dirty: boolean, head: string, upstream: string | null, upstreamSha: string | null, ahead: number, behind: number } | null} s.private
 *   the private repo, for a real deploy
 * @returns {{ errors: string[], warnings: string[], lines: string[] }}
 */
export function checkSources(s) {
	const refuse = [];
	const warnings = [];
	const lines = [];
	const short = (sha) => (sha ? sha.slice(0, 12) : 'none');

	if (!s.skipCiCheck) {
		const why = {
			failure: 'has failed',
			pending: 'has not finished',
			none: 'has not run',
			unknown: 'could not be checked (is gh installed and signed in?)'
		}[s.ci];
		if (why) refuse.push(`CI gate on origin/main (${short(s.sha)}) ${why}. Wait for it or fix it, or pass --skip-ci-check.`);
	} else if (s.ci !== 'success') warnings.push(`CI gate on origin/main (${short(s.sha)}) is ${s.ci}, published anyway (--skip-ci-check).`);
	lines.push(`CI gate: ${s.skipCiCheck ? `${s.ci}, not required (--skip-ci-check)` : s.ci}`);

	if (s.mode === 'real') {
		const p = s.private;
		if (!p) refuse.push('The private repo could not be read.');
		else {
			lines.push(`Private: ${short(p.head)}, upstream ${p.upstream ?? 'none'} at ${short(p.upstreamSha)}${p.ahead || p.behind ? ` (${p.ahead} ahead, ${p.behind} behind)` : ''}${p.dirty ? ', with uncommitted changes' : ''}`);
			const problems = [];
			if (!p.fetched) problems.push('its upstream could not be fetched, so it may be stale');
			if (!p.upstream) problems.push('its branch has no upstream to compare with');
			if (p.dirty) problems.push('it has uncommitted changes');
			if (p.ahead) problems.push(`it is ${p.ahead} commit${p.ahead === 1 ? '' : 's'} ahead of ${p.upstream}, not pushed`);
			if (p.behind) problems.push(`it is ${p.behind} commit${p.behind === 1 ? '' : 's'} behind ${p.upstream}`);
			if (problems.length) {
				const text = `The private repo is not what its upstream holds: ${problems.join('; ')}.`;
				if (s.allowDirty) warnings.push(`${text} Published as it stands (--allow-dirty).`);
				else refuse.push(`${text} Commit, push or pull it, or pass --allow-dirty.`);
			}
		}
	}

	if (s.dryRun) return { errors: [], warnings: [...warnings, ...refuse.map((e) => `a real run would refuse: ${e}`)], lines };
	return { errors: refuse, warnings, lines };
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

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'sources') {
	// node tools/deploy-check.mjs sources '<the checkSources argument, as JSON>'
	const { errors, warnings, lines } = checkSources(JSON.parse(process.argv[3] ?? 'null'));
	for (const l of lines) console.log(`  ${l}`);
	for (const w of warnings) console.warn(`Warning: ${w}`);
	for (const e of errors) console.error(`Refused: ${e}`);
	process.exit(errors.length ? 1 : 0);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [buildDir, mode] = process.argv.slice(2);
	if (!buildDir || !mode) {
		console.error('Usage: node tools/deploy-check.mjs <build dir> <sample|real>');
		process.exit(2);
	}
	if (!existsSync(buildDir)) {
		console.error(`No build at ${buildDir}.`);
		process.exit(1);
	}
	const files = listFiles(buildDir);
	const index = join(buildDir, 'data/index.json');
	const { errors, warnings } = checkBuild({ files, indexJson: existsSync(index) ? readFileSync(index, 'utf8') : null, mode });
	const { count, bytes } = summarize(files);
	console.log(`Build: ${count} files, ${MiB(bytes)}, ${mode} data.`);
	for (const w of warnings) console.warn(`Warning: ${w}`);
	for (const e of errors) console.error(`Refused: ${e}`);
	process.exit(errors.length ? 1 : 0);
}
