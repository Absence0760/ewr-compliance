// Bundles the API Lambda into dist/api.zip: one ESM file (index.mjs, handler `index.handler`),
// auth-kit and the AWS SDK inlined, so the package pins every version and nothing is fetched at
// run time. Node 24 on arm64 (infra/auth.tf). Deterministic: the zip's entries have a fixed time,
// so the same source gives the same CodeSha256.
//
//   pnpm build   (in server/)
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
	entryPoints: [join(root, 'src/lambda.ts')],
	outfile: join(out, 'index.mjs'),
	bundle: true,
	platform: 'node',
	target: 'node24',
	format: 'esm',
	minify: true,
	legalComments: 'none',
	sourcemap: false,
	// Some SDK modules still call require(); an ESM bundle needs one to hand.
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	logLevel: 'warning'
});

const zip = zipSync({ 'index.mjs': readFileSync(join(out, 'index.mjs')) });
writeFileSync(join(out, 'api.zip'), zip);
console.log(`dist/api.zip: ${(zip.length / 1024).toFixed(0)} KiB`);
