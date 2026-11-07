// The contract between the pipeline and the app: what the pipeline writes is what the app's own
// readers (src/lib/ewr/dwsStore.ts, parseGaugeFlows) accept, at the paths the app asks for. If this
// fails, either side has drifted from docs/architecture.md § DWS store.
import { describe, expect, it } from 'vitest';
import { dwsOffer, dwsPath, dwsStatus, parseDwsIndex, type DwsState } from '../../src/lib/ewr/dwsStore.ts';
import { gaugeSeries, parseGaugeFlows } from '../../src/lib/ewr/parsers.ts';
import type { GaugeFlowFile } from '../../src/lib/ewr/types.ts';
import { runDaily } from './run.ts';
import { KEYS, type MemoryStore } from './store.ts';
import { fakeDws, fixture, testRun } from './testing.ts';

/** The object CloudFront's /dws/* behaviour reads for a site path: origin_path /serve, then the whole path (infra/site.tf). */
const served = (store: MemoryStore, sitePath: string) => store.objects.get(`serve/${decodeURI(sitePath)}`)?.body;

async function pulled() {
	const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: fakeDws(({ station }) => ({ status: 200, body: fixture('X0H001-reply.synthetic.html').replaceAll('X0H001', station) })).fetch });
	await runDaily(ctx);
	return store;
}

describe('the store the pipeline writes, read by the app', () => {
	it('puts each file at the key CloudFront serves for the path the app asks for', () => {
		expect(KEYS.index).toBe(`serve/${dwsPath.index}`);
		expect(KEYS.flows('X0H001')).toBe(`serve/${dwsPath.flows('X0H001')}`);
	});

	it("writes an index the app's parseDwsIndex accepts, offering the store for a linked gauge", async () => {
		const store = await pulled();
		const index = parseDwsIndex(JSON.parse(served(store, dwsPath.index)!));
		expect(Object.keys(index.stations)).toEqual(['X0H001', 'X0H002']);
		const state: DwsState = { status: 'ready', index };
		const link = { node: 'Synthetic:n1', station: 'X0H001', factor: 1, note: '' };
		expect(dwsOffer(state, link, 'instant').ok).toBe(true);
		// No monthly file yet (the plan's Q1): the Historical Comparison keeps the gauge's own record.
		expect(dwsOffer(state, link, 'monthly').ok).toBe(false);
		expect(dwsStatus('X0H001', index.stations.X0H001!)).toEqual({ stale: false, text: 'Fetched 1 Apr 2010, 06:00 SAST, with daily flow from 2010-01-01 to 2010-03-31.' });
	});

	it('writes, for every station the index lists, a flows file parseGaugeFlows reads, with the gaps the app leaves undrawn', async () => {
		const store = await pulled();
		const index = parseDwsIndex(JSON.parse(served(store, dwsPath.index)!));
		for (const [station, e] of Object.entries(index.stations)) {
			const file = JSON.parse(served(store, dwsPath.flows(station))!) as GaugeFlowFile;
			expect(Object.keys(file).sort()).toEqual(['daily', 'readings']);
			const flows = parseGaugeFlows(file);
			expect(flows.daily).toHaveLength(89);
			expect(flows.readings).toEqual([]);
			const first = new Date(flows.daily[0]!.t).toISOString().slice(0, 10);
			const last = new Date(flows.daily.at(-1)!.t).toISOString().slice(0, 10);
			expect(e.covers).toEqual({ from: first, to: last });
			expect(flows.daily.find((p) => p.t === Date.UTC(2010, 1, 20))).toEqual({ t: Date.UTC(2010, 1, 20), v: null, code: '170' });
			// The node's factor scales the store's flow exactly as a gauge's (dwsRt, through gaugeSeries).
			const days = gaugeSeries(flows, 2).days;
			expect(days.find((d) => d.t === Date.UTC(2010, 0, 1))?.mean).toBe(3);
		}
	});

	it("holds the same shape as the e2e sample store the app's specs run against", async () => {
		const store = await pulled();
		const sample = (await import('../../e2e/fixtures/sample-store/index.json', { with: { type: 'json' } })).default as { stations: Record<string, object> };
		const ours = JSON.parse(served(store, dwsPath.index)!) as { version: number; stations: Record<string, object> };
		expect(ours.version).toBe(1);
		const keys = (o: object) => Object.keys(o).filter((k) => k !== 'monthly').sort();
		expect(keys(Object.values(ours.stations)[0]!)).toEqual(keys(Object.values(sample.stations)[0]!));
	});
});
