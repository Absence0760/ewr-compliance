// The DWS store's backfill plan: the input for the Step Functions backfill (infra/dws_backfill.tf),
// a list of date windows, newest first, each at most one request's span. No station is named: each
// window is pulled for every station in the store's own config/stations.json.
//
//   node tools/dws-backfill-plan.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--window-days N]
//
// --to defaults to today in South Africa; --window-days to 730, the pipeline's daily window
// (pipeline/src/hydata.ts DWS_WINDOW_DAYS). Newest first, so the recent record, which the app shows
// first, fills first. Starting the same plan again resumes it: windows already stored are skipped.
// docs/hosting.md has the command that starts it.
import { pathToFileURL } from 'node:url';

export const WINDOW_DAYS = 730;
export const MAX_WINDOW_DAYS = 20 * 365;
const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (v) => typeof v === 'string' && ISO.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const sastToday = (ms = Date.now()) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);

/** The windows from `to` back to `from`, newest first, each `windowDays` long but the oldest. */
export function plan({ from, to, windowDays = WINDOW_DAYS }) {
	if (!isDay(from) || !isDay(to)) throw new Error('--from and --to are days, YYYY-MM-DD.');
	if (from > to) throw new Error('--from is after --to.');
	if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) throw new Error(`--window-days is a whole number from 1 to ${MAX_WINDOW_DAYS}.`);
	const items = [];
	for (let end = to; end >= from; end = shift(end, -windowDays)) {
		const start = shift(end, -(windowDays - 1));
		items.push({ mode: 'backfill', from: start < from ? from : start, to: end });
	}
	return { items };
}

function args(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const [k, v] = [argv[i], argv[i + 1]];
		if (k === '--from') out.from = v;
		else if (k === '--to') out.to = v;
		else if (k === '--window-days') out.windowDays = Number(v);
		else throw new Error(`Unknown argument: ${k}`);
		i++;
	}
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		const a = args(process.argv.slice(2));
		if (!a.from) throw new Error('Usage: node tools/dws-backfill-plan.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--window-days N]');
		const p = plan({ to: sastToday(), ...a });
		process.stdout.write(`${JSON.stringify(p)}\n`);
		console.error(`${p.items.length} window${p.items.length === 1 ? '' : 's'}, newest first.`);
	} catch (e) {
		console.error(e.message);
		process.exit(2);
	}
}
