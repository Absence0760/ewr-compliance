import { describe, expect, it } from 'vitest';
import { parseDay } from '../../src/lib/ewr/parsers.ts';
import { PoliteClient } from './polite.ts';
import {
	checkWindow,
	lagMetricLine,
	MAX_UNAVAILABLE_IN_A_ROW,
	mergeDays,
	parseStations,
	REFRESH_HOURS,
	REFUSED_COOLDOWN_HOURS,
	runBackfill,
	runDaily,
	STALE_AFTER_DAYS,
	STOP_COOLDOWN_HOURS,
	type StatusFile
} from './run.ts';
import { KEYS, MemoryStore, SERVE_CACHE } from './store.ts';
import { fakeDws, fixture, page, row, testRun, type Reply, type TestRun } from './testing.ts';

const REPLY = fixture('X0H001-reply.synthetic.html');
const SCRIPTSERVER = fixture('X0H001-scriptserver.synthetic.html');
const ok = (body = REPLY): Reply => ({ status: 200, body });
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const status = (store: MemoryStore) => store.json(KEYS.status) as StatusFile;
const index = (store: MemoryStore) => store.json(KEYS.index) as { version: number; stations: Record<string, { fetchedAt: string; covers: { from: string; to: string }; stale: boolean; monthly: boolean }> };
/** Let go: overwritten as expired (lease.ts), never deleted. */
const leaseFree = (store: MemoryStore) => (store.json(KEYS.lease) as { expires: number } | undefined)?.expires === 0;
const daily = (store: MemoryStore, station: string) => (store.json(KEYS.flows(station)) as { daily: string }).daily;

describe('runDaily', () => {
	it("pulls each listed station's newest two years, and writes its flows, its raw page, the status and the index, in that order", async () => {
		const dws = fakeDws(() => ok());
		const { ctx, store, lags } = testRun({ fetch: dws.fetch });
		const r = await runDaily(ctx);
		expect(r).toMatchObject({ stopped: 'done', pulled: ['X0H001'], failed: [], requests: 1, lagDays: 0 });
		// Today in SAST, and the 729 days before it.
		expect(dws.requests).toEqual([expect.objectContaining({ station: 'X0H001', from: '2008-04-02', to: '2010-04-01' })]);
		expect(store.writes).toEqual([KEYS.lease, KEYS.flows('X0H001'), KEYS.raw('X0H001', '2008-04-02', '2010-04-01'), KEYS.status, KEYS.index, KEYS.status, KEYS.index, KEYS.lease]);
		expect(store.objects.get(KEYS.raw('X0H001', '2008-04-02', '2010-04-01'))?.body).toBe(REPLY);
		expect(index(store)).toEqual({ version: 1, stations: { X0H001: { fetchedAt: '2010-04-01T04:00:00.000Z', covers: { from: '2010-01-01', to: '2010-03-31' }, stale: false, monthly: false } } });
		expect(store.objects.get(KEYS.index)).toMatchObject({ contentType: 'application/json', cacheControl: SERVE_CACHE });
		expect(store.objects.get(KEYS.flows('X0H001'))).toMatchObject({ contentType: 'application/json', cacheControl: SERVE_CACHE });
		// The lease is let go.
		expect(leaseFree(store)).toBe(true);
		expect(lags).toEqual([0]);
	});

	it('keeps the gap rows: a code 170 day and a day with no row are missing, a coded value is kept', async () => {
		const { ctx, store } = testRun({ fetch: fakeDws(() => ok()).fetch });
		await runDaily(ctx);
		const points = parseDay(daily(store, 'X0H001'));
		const at = (y: number, m: number, d: number) => points.find((p) => p.t === Date.UTC(y, m - 1, d));
		expect(at(2010, 2, 20)).toEqual({ t: Date.UTC(2010, 1, 20), v: null, code: '170' });
		expect(at(2010, 2, 10)).toBeUndefined();
		expect(at(2010, 3, 5)).toMatchObject({ v: 2.42, code: '50' });
	});

	it('stops at a 403: the stations after it are not asked, what came before is kept, and the status says why', async () => {
		const dws = fakeDws(({ station }) => (station === 'X0H002' ? { status: 403 } : ok()));
		const { ctx, store, lags } = testRun({ stations: ['X0H001', 'X0H002', 'X0H003'], fetch: dws.fetch });
		await expect(runDaily(ctx)).rejects.toMatchObject({ name: 'DwsRefused' });
		expect(dws.requests.map((q) => q.station)).toEqual(['X0H001', 'X0H002']);
		const s = status(store);
		expect(s.stopped).toBe('refused');
		expect(s.stations.X0H001?.okAt).not.toBeNull();
		expect(s.stations.X0H002).toMatchObject({ okAt: null, covers: null });
		expect(s.stations.X0H003).toBeUndefined();
		expect(Object.keys(index(store).stations)).toEqual(['X0H001']);
		expect(leaseFree(store)).toBe(true);
		expect(lags).toHaveLength(1);
	});

	it("stops at DWS's ScriptServer page the same way", async () => {
		const dws = fakeDws(({ station }) => (station === 'X0H001' ? ok(SCRIPTSERVER) : ok()));
		const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		await expect(runDaily(ctx)).rejects.toMatchObject({ name: 'DwsServerError' });
		expect(dws.requests).toHaveLength(1);
		expect(status(store).stopped).toBe('server_error');
		expect(store.objects.has(KEYS.flows('X0H001'))).toBe(false);
	});

	it('stops when DWS keeps throttling past what the run can wait', async () => {
		const dws = fakeDws(() => ({ status: 429, headers: { 'Retry-After': '3600' } }));
		const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		await expect(runDaily(ctx)).rejects.toMatchObject({ name: 'DwsThrottled' });
		expect(dws.requests).toHaveLength(1);
		expect(status(store).stopped).toBe('throttled');
	});

	it("skips a station whose own page fails, logging only its code and a fixed label, and goes on", async () => {
		const dws = fakeDws(({ station }) => (station === 'X0H001' ? ok('<html>changed</html>') : ok(REPLY.replaceAll('X0H001', station))));
		const { ctx, store, logs } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		const r = await runDaily(ctx);
		expect(r).toMatchObject({ stopped: 'done', pulled: ['X0H002'], failed: ['X0H001'] });
		expect(logs).toContainEqual({ level: 'warn', fields: { event: 'dws_station_failed', station: 'X0H001', check: 'no data table' } });
		expect(status(store).stations.X0H001).toMatchObject({ okAt: null, covers: null });
		expect(Object.keys(index(store).stations)).toEqual(['X0H002']);
		// The run's own line has counts, never the list.
		// X0H001 has never been current: its lag counts from the list's date, 2010-01-01.
		expect(logs.find((l) => l.fields.event === 'dws_run')?.fields).toEqual({ event: 'dws_run', mode: 'daily', stopped: 'done', pulled: 1, failed: 1, skipped: 0, requests: 2, lagDays: 90 });
	});

	it('writes the status however the run ends, even when the store refuses a write', async () => {
		const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: fakeDws(() => ok()).fetch });
		store.failPut = /flows-X0H002/;
		await expect(runDaily(ctx)).rejects.toThrow('MemoryStore refused');
		expect(status(store).stations.X0H001?.okAt).not.toBeNull();
		expect(status(store).stations.X0H002?.triedAt).toBeDefined();
		expect(leaseFree(store)).toBe(true);
	});

	it('merges a later window into the stored days: the later fetch wins day by day, and no stored day is dropped', async () => {
		const store = new MemoryStore();
		const first = testRun({ fetch: fakeDws(() => ok()).fetch, store });
		await runDaily(first.ctx);
		// A day later DWS lists only late March and the new day, and has revised the 30th.
		const later = page('X0H001', [row('2010-03-29', '5.000', '1'), row('2010-03-30', '6.000', '2'), row('2010-03-31', '', '170'), row('2010-04-01', '7.000', '1')]);
		const next = testRun({ fetch: fakeDws(() => ok(later)).fetch, store, at: '2010-04-02T04:00:00Z' });
		await runDaily(next.ctx);
		const points = parseDay(daily(store, 'X0H001'));
		const v = (m: number, d: number) => points.find((p) => p.t === Date.UTC(2010, m - 1, d));
		expect(v(1, 1)).toMatchObject({ v: 1.5, code: '1' });
		expect(v(3, 30)).toMatchObject({ v: 6, code: '2' });
		expect(v(3, 31)).toMatchObject({ v: null, code: '170' });
		expect(v(4, 1)).toMatchObject({ v: 7 });
		expect(points).toHaveLength(89 + 1);
		expect(index(store).stations.X0H001?.covers).toEqual({ from: '2010-01-01', to: '2010-04-01' });
	});

	it('keeps a page with no data from touching the stored days', async () => {
		const store = new MemoryStore();
		await runDaily(testRun({ fetch: fakeDws(() => ok()).fetch, store }).ctx);
		const before = store.objects.get(KEYS.flows('X0H001'))?.body;
		await runDaily(testRun({ fetch: fakeDws(() => ok(fixture('X0H001-nodata.synthetic.html'))).fetch, store, at: '2010-04-02T04:00:00Z' }).ctx);
		expect(store.objects.get(KEYS.flows('X0H001'))?.body).toBe(before);
	});

	it('lists a station only once its flows file holds a day', async () => {
		const { ctx, store } = testRun({ fetch: fakeDws(() => ok(fixture('X0H001-nodata.synthetic.html'))).fetch });
		await runDaily(ctx);
		expect(store.objects.has(KEYS.flows('X0H001'))).toBe(false);
		expect(index(store)).toEqual({ version: 1, stations: {} });
		expect(status(store).stations.X0H001).toMatchObject({ covers: null });
	});

	it("doesn't ask DWS, or touch the store, while another run holds the lease", async () => {
		const dws = fakeDws(() => ok());
		const { ctx, store, logs, lags } = testRun({ fetch: dws.fetch });
		await store.put(KEYS.lease, JSON.stringify({ owner: 'other', holder: 'backfill', expires: (ctx.now() + 600_000) / 1000 }), { contentType: 'application/json' });
		const r = await runDaily(ctx);
		expect(r.stopped).toBe('busy');
		expect(dws.requests).toHaveLength(0);
		expect(store.objects.has(KEYS.status)).toBe(false);
		expect((store.json(KEYS.lease) as { owner: string }).owner).toBe('other');
		expect(logs[0]?.fields).toMatchObject({ event: 'dws_lease_busy', holder: 'backfill' });
		expect(lags).toHaveLength(1);
	});

	it('pulls a station again only once its last current pull is REFRESH_HOURS old', async () => {
		const store = new MemoryStore();
		await runDaily(testRun({ fetch: fakeDws(() => ok()).fetch, store }).ctx);
		const soon = fakeDws(() => ok());
		const r = await runDaily(testRun({ fetch: soon.fetch, store, at: new Date(Date.parse('2010-04-01T04:00:00Z') + (REFRESH_HOURS - 1) * HOUR).toISOString() }).ctx);
		expect(r).toMatchObject({ skipped: 1, pulled: [] });
		expect(soon.requests).toHaveLength(0);
	});

	it('asks for never-tried stations first, then by their last turn, oldest first', async () => {
		const store = new MemoryStore();
		const answer = ({ station }: { station: string }) => (station === 'X0H001' ? ok('<html>changed</html>') : ok(REPLY.replaceAll('X0H001', station)));
		await runDaily(testRun({ stations: ['X0H001', 'X0H002'], fetch: fakeDws(answer).fetch, store }).ctx);
		await store.put(KEYS.stations, JSON.stringify({ v: 1, at: '2010-04-01T05:00:00Z', stations: ['X0H001', 'X0H002', 'X0H003'] }), { contentType: 'application/json' });
		const next = fakeDws(answer);
		await runDaily(testRun({ fetch: next.fetch, store, at: '2010-04-02T04:00:00Z' }).ctx);
		expect(next.requests.map((q) => q.station)).toEqual(['X0H003', 'X0H001', 'X0H002']);
	});

	it('puts a station that keeps failing behind one that was current more recently, rather than first every run', async () => {
		const store = new MemoryStore();
		const t = (h: number) => new Date(Date.parse('2010-04-10T04:00:00Z') - h * HOUR).toISOString();
		const s: StatusFile = {
			v: 1,
			runAt: t(1),
			mode: 'daily',
			stopped: null,
			stations: {
				// Last current ten days ago, but tried (and failed) an hour ago.
				X0H001: { okAt: t(240), currentAt: t(240), triedAt: t(1), covers: { from: '2010-01-01', to: '2010-03-31' }, validators: null },
				// Current 21 hours ago.
				X0H002: { okAt: t(21), currentAt: t(21), triedAt: t(21), covers: { from: '2010-01-01', to: '2010-03-31' }, validators: null }
			}
		};
		await store.put(KEYS.status, JSON.stringify(s), { contentType: 'application/json' });
		const dws = fakeDws(({ station }) => ok(REPLY.replaceAll('X0H001', station)));
		await runDaily(testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch, store, at: '2010-04-10T04:00:00Z' }).ctx);
		expect(dws.requests.map((q) => q.station)).toEqual(['X0H002', 'X0H001']);
	});

	it('marks a station stale once its pulls have stopped keeping it current, and says so in the lag', async () => {
		const store = new MemoryStore();
		await runDaily(testRun({ fetch: fakeDws(() => ok()).fetch, store }).ctx);
		const at = new Date(Date.parse('2010-04-01T04:00:00Z') + (STALE_AFTER_DAYS + 1) * DAY).toISOString();
		const late = testRun({ fetch: fakeDws(() => ok('<html>changed</html>')).fetch, store, at });
		const r = await runDaily(late.ctx);
		expect(index(store).stations.X0H001).toMatchObject({ stale: true, fetchedAt: '2010-04-01T04:00:00.000Z' });
		expect(r.lagDays).toBe(STALE_AFTER_DAYS + 1);
	});

	it('stops starting stations at the deadline; the rest go first next run', async () => {
		const dws = fakeDws(() => ok());
		const { ctx, time } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		time.advance(900_000);
		const r = await runDaily(ctx);
		expect(r).toMatchObject({ stopped: 'deadline', pulled: [] });
		expect(dws.requests).toHaveLength(0);
	});

	it('does nothing without a station list', async () => {
		const dws = fakeDws(() => ok());
		const { ctx, store } = testRun({ stations: null, fetch: dws.fetch });
		expect(await runDaily(ctx)).toMatchObject({ stopped: 'no_stations', lagDays: null });
		expect(dws.requests).toHaveLength(0);
		expect(store.writes).toEqual([]);
	});

	it('never overwrites a stored flows file it cannot read', async () => {
		const store = new MemoryStore();
		await store.put(KEYS.flows('X0H001'), 'not json', { contentType: 'application/json' });
		const { ctx, logs } = testRun({ fetch: fakeDws(() => ok()).fetch, store });
		const r = await runDaily(ctx);
		expect(r.failed).toEqual(['X0H001']);
		expect(store.objects.get(KEYS.flows('X0H001'))?.body).toBe('not json');
		expect(logs).toContainEqual({ level: 'warn', fields: { event: 'dws_station_failed', station: 'X0H001', check: 'stored flows unreadable' } });
	});

	it('drops a station taken off the list from the status and the index', async () => {
		const store = new MemoryStore();
		await runDaily(testRun({ stations: ['X0H001', 'X0H002'], fetch: fakeDws(({ station }) => ok(REPLY.replaceAll('X0H001', station))).fetch, store }).ctx);
		expect(Object.keys(index(store).stations)).toEqual(['X0H001', 'X0H002']);
		await store.put(KEYS.stations, JSON.stringify({ v: 1, at: '2010-04-01T05:00:00Z', stations: ['X0H002'] }), { contentType: 'application/json' });
		await runDaily(testRun({ fetch: fakeDws(() => ok()).fetch, store, at: '2010-04-02T04:00:00Z' }).ctx);
		expect(Object.keys(index(store).stations)).toEqual(['X0H002']);
		expect(Object.keys(status(store).stations)).toEqual(['X0H002']);
	});

	it('asks again with the validators of the same window, and takes a 304 as current and unchanged', async () => {
		const store = new MemoryStore();
		await runDaily(testRun({ fetch: fakeDws(() => ({ status: 200, body: REPLY, headers: { ETag: '"v1"' } })).fetch, store }).ctx);
		// The same day's window again (say a re-run by hand after the refresh time).
		const s = status(store);
		s.stations.X0H001!.currentAt = '2010-03-30T00:00:00.000Z';
		await store.put(KEYS.status, JSON.stringify(s), { contentType: 'application/json' });
		const before = store.objects.get(KEYS.flows('X0H001'))?.body;
		const again = fakeDws(() => ({ status: 304 }));
		await runDaily(testRun({ fetch: again.fetch, store, at: '2010-04-01T20:00:00Z' }).ctx);
		expect(again.requests[0]?.headers['If-None-Match']).toBe('"v1"');
		expect(store.objects.get(KEYS.flows('X0H001'))?.body).toBe(before);
		expect(status(store).stations.X0H001?.currentAt).toBe('2010-04-01T20:00:00.000Z');
	});
});

describe('after DWS stops a run', () => {
	const refusedAt = async (store: MemoryStore, at = '2010-04-01T04:00:00Z') => {
		await expect(runDaily(testRun({ fetch: fakeDws(() => ({ status: 403 })).fetch, store, at }).ctx)).rejects.toMatchObject({ name: 'DwsRefused' });
	};

	it('asks DWS nothing for most of a day after a 403, daily or backfill, and says so', async () => {
		const store = new MemoryStore();
		await refusedAt(store);
		const later = fakeDws(() => ok());
		const daily = testRun({ fetch: later.fetch, store, at: new Date(Date.parse('2010-04-01T04:00:00Z') + (REFUSED_COOLDOWN_HOURS - 1) * HOUR).toISOString() });
		expect(await runDaily(daily.ctx)).toMatchObject({ stopped: 'cooling', requests: 0 });
		expect(daily.logs.at(-1)?.fields).toMatchObject({ event: 'dws_run', reason: 'refused' });
		expect(daily.lags).toHaveLength(1);
		// A backfill waiting on the lease is the case that matters: it must not ask minutes after the 403.
		await expect(runBackfill(testRun({ fetch: later.fetch, store, at: '2010-04-01T04:05:00Z' }).ctx, { from: '2010-01-01', to: '2010-03-31' })).rejects.toMatchObject({ name: 'DwsCoolingDown' });
		expect(later.requests).toHaveLength(0);
		// The stop stays recorded until a run gets through.
		expect(status(store).stopped).toBe('refused');
	});

	it('asks again once the cool-down has passed, and the next good run clears the stop', async () => {
		const store = new MemoryStore();
		await refusedAt(store);
		const next = fakeDws(() => ok());
		await runDaily(testRun({ fetch: next.fetch, store, at: '2010-04-02T04:00:00Z' }).ctx);
		expect(next.requests).toHaveLength(1);
		expect(status(store).stopped).toBeNull();
	});

	it("asks again inside the cool-down only when the operator's event says ignoreStop", async () => {
		const store = new MemoryStore();
		await refusedAt(store);
		const dws = fakeDws(() => ok());
		const run = testRun({ fetch: dws.fetch, store, at: '2010-04-01T05:00:00Z' });
		run.ctx.ignoreStop = true;
		await runDaily(run.ctx);
		expect(dws.requests).toHaveLength(1);
	});

	it('cools down for an hour after throttling, not a day', async () => {
		const store = new MemoryStore();
		await expect(runDaily(testRun({ fetch: fakeDws(() => ({ status: 429, headers: { 'Retry-After': '3600' } })).fetch, store }).ctx)).rejects.toMatchObject({ name: 'DwsThrottled' });
		const soon = fakeDws(() => ok());
		expect(await runDaily(testRun({ fetch: soon.fetch, store, at: new Date(Date.parse('2010-04-01T04:00:00Z') + (STOP_COOLDOWN_HOURS * HOUR) / 2).toISOString() }).ctx)).toMatchObject({ stopped: 'cooling' });
		await runDaily(testRun({ fetch: soon.fetch, store, at: new Date(Date.parse('2010-04-01T04:00:00Z') + STOP_COOLDOWN_HOURS * HOUR + 1000).toISOString() }).ctx);
		expect(soon.requests).toHaveLength(1);
	});
});

describe('when DWS is down', () => {
	it(`stops asking after ${MAX_UNAVAILABLE_IN_A_ROW} stations it did not answer`, async () => {
		const stations = ['X0H001', 'X0H002', 'X0H003', 'X0H004', 'X0H005', 'X0H006', 'X0H007'];
		const dws = fakeDws(() => ({ status: 502 }));
		const { ctx, store } = testRun({ stations, fetch: dws.fetch });
		await expect(runDaily(ctx)).rejects.toMatchObject({ name: 'DwsDown' });
		expect(dws.requests).toHaveLength(MAX_UNAVAILABLE_IN_A_ROW);
		expect(status(store).stopped).toBe('unavailable');
	});

	it('counts only stations running: a page that answered resets the count', async () => {
		const stations = ['X0H001', 'X0H002', 'X0H003', 'X0H004', 'X0H005', 'X0H006'];
		const dws = fakeDws(({ station }) => (station === 'X0H003' ? ok(REPLY.replaceAll('X0H001', station)) : { status: 502 }));
		const r = await runDaily(testRun({ stations, fetch: dws.fetch }).ctx);
		expect(r).toMatchObject({ stopped: 'done', pulled: ['X0H003'] });
		expect(dws.requests).toHaveLength(6);
	});
});

describe('the deadline', () => {
	it('cuts a request short rather than let it outlive the run, and the status is still saved', async () => {
		const store = new MemoryStore();
		let run: TestRun | undefined;
		// The first page answers at once; the second never would, and is aborted at the deadline.
		const fetch = (async (input: URL | string, init?: RequestInit) => {
			const station = new URL(String(input)).searchParams.get('Station');
			if (station === 'X0H001100.00') return new Response(REPLY, { status: 200 });
			return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
		}) as typeof globalThis.fetch;
		run = testRun({ stations: ['X0H001', 'X0H002'], fetch, store });
		const client = new PoliteClient({ now: run.time.now, sleep: run.time.sleep, fetch, deadline: run.ctx.now() + 1500 });
		run.ctx.client = client;
		run.ctx.deadline = run.ctx.now() + 1500;
		const r = await runDaily(run.ctx);
		expect(r).toMatchObject({ stopped: 'deadline', pulled: ['X0H001'], failed: [] });
		expect(status(store).stations.X0H001?.okAt).not.toBeNull();
		expect(leaseFree(store)).toBe(true);
	});

	it('fails a backfill item as WindowUnfinished, not as a failed station, when a request is cut short', async () => {
		const fetch = (async (_: URL | string, init?: RequestInit) =>
			new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof globalThis.fetch;
		const run = testRun({ fetch });
		run.ctx.client = new PoliteClient({ now: run.time.now, sleep: run.time.sleep, fetch, deadline: run.ctx.now() + 1500 });
		await expect(runBackfill(run.ctx, { from: '2010-01-01', to: '2010-03-31' })).rejects.toMatchObject({ name: 'WindowUnfinished' });
	});
});

describe('runBackfill', () => {
	const W = { from: '2010-01-01', to: '2010-03-31' };

	it('pulls the window for every listed station, and skips the ones already stored when started again', async () => {
		const store = new MemoryStore();
		const dws = fakeDws(({ station }) => ok(REPLY.replaceAll('X0H001', station)));
		const r = await runBackfill(testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch, store }).ctx, W);
		expect(r).toMatchObject({ pulled: ['X0H001', 'X0H002'], skipped: 0 });
		expect(dws.requests.map((q) => [q.station, q.from, q.to])).toEqual([
			['X0H001', '2010-01-01', '2010-03-31'],
			['X0H002', '2010-01-01', '2010-03-31']
		]);
		const again = fakeDws(() => ok());
		expect(await runBackfill(testRun({ stations: ['X0H001', 'X0H002'], fetch: again.fetch, store }).ctx, W)).toMatchObject({ pulled: [], skipped: 2 });
		expect(again.requests).toHaveLength(0);
	});

	it("doesn't make an old window current: the station stays stale until a window reaching today", async () => {
		const { ctx, store } = testRun({ fetch: fakeDws(() => ok()).fetch, at: '2011-01-01T04:00:00Z' });
		await runBackfill(ctx, W);
		expect(index(store).stations.X0H001).toMatchObject({ stale: true });
		expect(status(store).stations.X0H001?.currentAt).toBeNull();
	});

	it('fails the item as LeaseBusy, asking nothing, while another run holds the lease', async () => {
		const dws = fakeDws(() => ok());
		const { ctx, store } = testRun({ fetch: dws.fetch });
		await store.put(KEYS.lease, JSON.stringify({ owner: 'other', holder: 'daily', expires: (ctx.now() + 600_000) / 1000 }), { contentType: 'application/json' });
		await expect(runBackfill(ctx, W)).rejects.toMatchObject({ name: 'LeaseBusy' });
		expect(dws.requests).toHaveLength(0);
	});

	it('fails the item as DwsRefused at a 403, with the status saved', async () => {
		const dws = fakeDws(() => ({ status: 403 }));
		const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		await expect(runBackfill(ctx, W)).rejects.toMatchObject({ name: 'DwsRefused' });
		expect(dws.requests).toHaveLength(1);
		expect(status(store)).toMatchObject({ mode: 'backfill', stopped: 'refused' });
	});

	it('fails the item as WindowUnfinished at the deadline, and the retry carries on where it stopped', async () => {
		const store = new MemoryStore();
		let run: TestRun | undefined;
		// Each page takes a minute to come back.
		const answer = ({ station }: { station: string }) => (run?.time.advance(60_000), ok(REPLY.replaceAll('X0H001', station)));
		run = testRun({ stations: ['X0H001', 'X0H002'], fetch: fakeDws(answer).fetch, store });
		run.ctx.deadline = run.ctx.now() + 30_000;
		await expect(runBackfill(run.ctx, W)).rejects.toMatchObject({ name: 'WindowUnfinished' });
		const retry = fakeDws(answer);
		expect(await runBackfill(testRun({ stations: ['X0H001', 'X0H002'], fetch: retry.fetch, store }).ctx, W)).toMatchObject({ pulled: ['X0H002'], skipped: 1 });
		expect(retry.requests.map((q) => q.station)).toEqual(['X0H002']);
	});

	it('finishes the window, then fails as DwsStationsFailed when a station failed', async () => {
		const dws = fakeDws(({ station }) => (station === 'X0H001' ? ok('<html>changed</html>') : ok(REPLY.replaceAll('X0H001', station))));
		const { ctx, store } = testRun({ stations: ['X0H001', 'X0H002'], fetch: dws.fetch });
		await expect(runBackfill(ctx, W)).rejects.toMatchObject({ name: 'DwsStationsFailed' });
		expect(store.objects.has(KEYS.raw('X0H002', W.from, W.to))).toBe(true);
		expect(store.objects.has(KEYS.raw('X0H001', W.from, W.to))).toBe(false);
	});

	it('refuses to run without a station list', async () => {
		await expect(runBackfill(testRun({ stations: null, fetch: fakeDws(() => ok()).fetch }).ctx, W)).rejects.toMatchObject({ name: 'StoreFormatError' });
	});
});

describe('checkWindow', () => {
	it('takes real days, in order, within twenty years, not after today', () => {
		expect(checkWindow('2010-01-01', '2010-03-31', '2026-01-01')).toEqual({ from: '2010-01-01', to: '2010-03-31' });
		for (const [f, t] of [
			['2010-02-30', '2010-03-31'],
			['2010-03-31', '2010-01-01'],
			['1990-01-01', '2026-01-01'],
			['2025-12-01', '2026-01-02'],
			[20100101, '2010-03-31'],
			['2010-01-01', '2010-03-31; X']
		]) {
			expect(() => checkWindow(f, t, '2026-01-01')).toThrow();
		}
	});
});

describe('parseStations', () => {
	it('takes a v1 list of distinct river gauges, sorted', () => {
		expect(parseStations(JSON.stringify({ v: 1, at: '2026-01-01T00:00:00Z', stations: ['X0H002', 'X0H001'] })).stations).toEqual(['X0H001', 'X0H002']);
	});

	it.each([
		['not JSON', '{'],
		['another version', JSON.stringify({ v: 2, at: '2026-01-01T00:00:00Z', stations: [] })],
		['a reservoir', JSON.stringify({ v: 1, at: '2026-01-01T00:00:00Z', stations: ['X0R001'] })],
		['a station twice', JSON.stringify({ v: 1, at: '2026-01-01T00:00:00Z', stations: ['X0H001', 'X0H001'] })],
		['no time zone on at', JSON.stringify({ v: 1, at: '2026-01-01T00:00:00', stations: [] })]
	])('refuses %s', (_, text) => {
		expect(() => parseStations(text)).toThrow();
	});
});

describe('mergeDays', () => {
	it('lets the later rows win day by day and keeps every other day, in date order', () => {
		const stored = new Map([
			['20100101', { day: '20100101', flow: '1.000', code: '1' }],
			['20100102', { day: '20100102', flow: '2.000', code: '1' }]
		]);
		expect(mergeDays(stored, [{ day: '20100102', flow: '', code: '170' }, { day: '20091231', flow: '0.500', code: '1' }])).toEqual([
			{ day: '20091231', flow: '0.500', code: '1' },
			{ day: '20100101', flow: '1.000', code: '1' },
			{ day: '20100102', flow: '', code: '170' }
		]);
	});
});

describe('lagMetricLine', () => {
	it('is an Embedded Metric Format line for DwsLagDays', () => {
		expect(JSON.parse(lagMetricLine(3, 0))).toEqual({
			_aws: { Timestamp: 0, CloudWatchMetrics: [{ Namespace: 'ewr-compliance/Dws', Dimensions: [['Pipeline']], Metrics: [{ Name: 'DwsLagDays', Unit: 'None' }] }] },
			Pipeline: 'dws',
			DwsLagDays: 3
		});
	});
});
