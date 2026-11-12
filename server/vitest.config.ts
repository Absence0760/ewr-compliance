import { defineConfig } from 'vitest/config';

export default defineConfig({
	// This package's tsconfig for every file, the app's src/lib/ewr/nodeStore.ts included: the transform
	// would otherwise take the app's own tsconfig.json for it, which extends SvelteKit's generated one,
	// and that exists only once the app is installed and synced (as pipeline/vitest.config.ts).
	tsconfig: './tsconfig.json',
	test: {
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		environment: 'node'
	}
});
