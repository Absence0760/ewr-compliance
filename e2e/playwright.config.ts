// End-to-end tests against a production build, on port 7795 so a dev server on 7790 is left alone,
// and a build for a sub-path on port 7796.
// Nothing here reaches outside the repo: the data is static/data, the flow files are e2e/fixtures,
// the DWS boundaries are stubbed, and any other request off the site fails the test (support/app.ts).
// The build leaves the base map out, because CI has no tiles and the file is local to this machine.
//
// Two tiers, because a spec pins the numbers of one dataset. `pnpm test:e2e` runs the specs here
// against the synthetic sample. `pnpm test:private` (EWR_TIER=private) runs tests/private, copied in
// by `pnpm data:private`, against real data, and the one spec here that pins no data.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = 7795;
const NO_TILES = 'VITE_TILES_URL= VITE_TILES_GLYPHS_URL=';
const CI = !!process.env.CI;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE = process.env.EWR_TIER === 'private';

/** A spec run on the wrong dataset fails on every number, so say what is wrong instead. */
function requireData() {
	const index = `${ROOT}static/data/index.json`;
	if (!existsSync(index)) throw new Error('static/data is empty. Run `pnpm data:sample`, or `pnpm data:private` for the real data.');
	const sample = JSON.parse(readFileSync(index, 'utf8')).sample === true;
	if (PRIVATE && sample) throw new Error('static/data holds the sample. `pnpm test:private` copies the real data first.');
	if (!PRIVATE && !sample) throw new Error('static/data holds real data, and these specs pin the sample. Run `pnpm test:private`, or `pnpm data:sample --force`.');
}

requireData();

export default defineConfig({
	testDir: './tests',
	testMatch: PRIVATE ? ['private/**/*.spec.ts', 'console-clean.spec.ts'] : '*.spec.ts',
	testIgnore: PRIVATE ? [] : 'private/**',
	fullyParallel: true,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	// Software WebGL is all CPU, so a map on every worker needs a limit.
	workers: CI ? 2 : 4,
	reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
		// Where the app is used, and two hours off UTC, so a date that slips a timezone fails here.
		timezoneId: 'Africa/Johannesburg',
		locale: 'en-ZA',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// CI has no GPU: MapLibre needs WebGL, and SwiftShader gives it one in software.
				launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
			}
		}
	],
	webServer: [
		// hosting.spec.ts: a build for a sub-path, on a plain static host. Built first and moved out,
		// because the next build replaces build/ and the output `pnpm preview` serves.
		{
			command: `${NO_TILES} BASE_PATH=/ewr pnpm build && rm -rf .svelte-kit/subpath && mv build .svelte-kit/subpath && node e2e/support/static-host.mjs .svelte-kit/subpath ${PORT + 1} /ewr/`,
			cwd: ROOT,
			url: `http://localhost:${PORT + 1}/ewr/`,
			reuseExistingServer: !CI,
			timeout: 180_000
		},
		{
			// `pnpm preview` carries its own --port; the last one given wins.
			command: `${NO_TILES} pnpm build && pnpm preview --port ${PORT} --strictPort`,
			cwd: ROOT,
			url: `http://localhost:${PORT}`,
			reuseExistingServer: !CI,
			timeout: 180_000
		}
	]
});
