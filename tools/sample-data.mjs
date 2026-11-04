// `pnpm data:sample`: copies the synthetic dataset in e2e/fixtures/sample-data to static/data.
// Real data in static/data is not synthetic and may be the only copy to hand, so this refuses to
// overwrite it. `pnpm data:sample --force` overwrites it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const DATA = path('static/data/');
const SAMPLE = path('e2e/fixtures/sample-data/');

// On a fresh clone the folder is not there: git keeps nothing in it.
mkdirSync(DATA, { recursive: true });
const present = readdirSync(DATA);
const isSample = existsSync(`${DATA}index.json`) && JSON.parse(readFileSync(`${DATA}index.json`, 'utf8')).sample === true;

if (present.length && !isSample) {
	if (!process.argv.includes('--force')) {
		console.error('static/data holds data that is not the sample, so it was left alone.');
		console.error('Run `pnpm data:sample --force` to replace it. `pnpm data:private` copies the real data back.');
		process.exit(1);
	}
	console.log(`Replacing ${present.length} files of real data in static/data.`);
}

for (const f of present) rmSync(`${DATA}${f}`);
const files = readdirSync(SAMPLE);
for (const f of files) copyFileSync(`${SAMPLE}${f}`, `${DATA}${f}`);
console.log(`Copied ${files.length} synthetic files to static/data.`);
