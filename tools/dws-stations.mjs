// The DWS store's station list, config/stations.json, from a gauges.json's links: every station a node
// is linked to, which is what the app's "DWS (kept current)" source is offered for
// (docs/architecture.md § DWS store). tools/dws-stations.sh uploads it.
//
//   node tools/dws-stations.mjs <gauges.json>   prints the list's JSON
//
// Only river gauges (H codes) are listed: the pipeline asks HyData.aspx with SiteType=RIV and refuses a
// list holding anything else (pipeline/src/run.ts parseStations). Other links are counted on stderr,
// never named: station codes are client material, and this may run where its output is logged.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RIVER_GAUGE = /^[A-Z][0-9]H[0-9]{3}$/;
export const MAX_STATIONS = 500;

/** The list, sorted and without repeats, and how many links were left out. Throws on a gauges.json without links. */
export function stationsFile(gauges, at) {
	if (!gauges || !Array.isArray(gauges.links)) throw new Error('gauges.json has no links list.');
	const all = new Set(gauges.links.map((l) => (typeof l?.station === 'string' ? l.station.trim().toUpperCase() : '')));
	const stations = [...all].filter((s) => RIVER_GAUGE.test(s)).sort();
	if (stations.length > MAX_STATIONS) throw new Error(`gauges.json links ${stations.length} river gauges; the pipeline takes at most ${MAX_STATIONS}.`);
	return { file: { v: 1, at, stations }, skipped: all.size - stations.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const path = process.argv[2];
	if (!path) {
		console.error('Usage: node tools/dws-stations.mjs <gauges.json>');
		process.exit(2);
	}
	const { file, skipped } = stationsFile(JSON.parse(readFileSync(path, 'utf8')), new Date().toISOString());
	if (skipped) console.error(`Left out ${skipped} linked station${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'is' : 'are'} not a river gauge (an H code).`);
	process.stdout.write(`${JSON.stringify(file)}\n`);
}
