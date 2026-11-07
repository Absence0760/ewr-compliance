import { defineConfig } from 'vitest/config';

export default defineConfig({
	// This package's tsconfig for every file, the app's src/lib/ewr included: the transform would
	// otherwise take the app's own tsconfig.json for those, which extends SvelteKit's generated one,
	// and that exists only once the app is installed and synced (this package's CI job does neither).
	tsconfig: './tsconfig.json',
	test: {
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		environment: 'node'
	}
});
