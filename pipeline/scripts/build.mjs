// The Lambda bundle: src/handler.ts and everything it imports, the AWS SDK and EWR's own parsers
// (src/lib/ewr, by relative path) included, as one ES module for nodejs24.x on arm64, zipped as
// dist/pipeline.zip with the handler at index.handler. deploy-lambdas.yml uploads the zip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
	entryPoints: [join(root, 'src/handler.ts')],
	outfile: join(dist, 'index.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	minify: false,
	sourcemap: false,
	legalComments: 'none',
	// This package's tsconfig for every file, as vitest.config.ts: the app's own, which src/lib/ewr would
	// otherwise get, extends SvelteKit's generated one, there only once the app is installed and synced.
	tsconfig: join(root, 'tsconfig.json'),
	// The SDK's CommonJS parts call require(); an ES module has none until it is made.
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	logLevel: 'warning'
});

// -X leaves out file attributes, so the same source zips the same.
execFileSync('zip', ['-X', '-q', 'pipeline.zip', 'index.mjs'], { cwd: dist });
console.log('dist/pipeline.zip');
