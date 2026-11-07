import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ command }) => ({
	plugins: [
		sveltekit({
			// A static site: there is no server, and flow files stay in the browser.
			adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
			// The pages find their own base at run time. Only 404.html, served from any depth, needs it set.
			paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}` },
			// A meta tag in each built page, so no host has to set it. Left out of the dev server, whose
			// tooling is not what this describes. docs/hosting.md explains each origin.
			csp: {
				mode: 'hash',
				directives:
					command === 'build'
						? {
								'default-src': ['none'],
								'script-src': ['self'],
								// Svelte templates and MapLibre set style attributes.
								'style-src': ['self', 'unsafe-inline'],
								// MapLibre's controls are data: images.
								'img-src': ['self', 'data:'],
								'worker-src': ['self'],
								// Schemes and not a list, because the API address is typed in by the user.
								'connect-src': ['self', 'https:', 'http:'],
								'base-uri': ['self'],
								'form-action': ['none'],
								'object-src': ['none']
							}
						: {}
			}
		})
	],
	test: {
		include: ['src/**/*.test.ts', 'functions/**/*.test.ts', 'tools/**/*.test.ts'],
		// src/private is real-data tests, copied in by `pnpm data:private`. Only `pnpm test:private` runs them.
		exclude: process.env.EWR_TIER === 'private' ? configDefaults.exclude : [...configDefaults.exclude, 'src/private/**'],
		environment: 'node'
	}
}));
