// Test support: a stand-in for DWS's HyData.aspx, built from the synthetic X0H00x fixtures, and a run
// context over a MemoryStore with a clock the tests move. Never imported by the Lambda.
import { readFileSync } from 'node:fs';
import { PoliteClient } from './polite.ts';
import type { Log, RunContext } from './run.ts';
import { KEYS, MemoryStore } from './store.ts';

export const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** A HyData.aspx daily page holding these rows, as the synthetic reply lays them out. */
export function page(station: string, rows: string[]): string {
	return [
		'<p><pre>The format of this file is as follows:',
		'POS.  1-8   = Date of daily flow  CCYYMMDD',
		'POS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999',
		'POS. 20-24  = Quality code',
		'',
		`${station} (SYNTHETIC WEIR)`,
		'',
		'DATE     D AVG F/R  QUAL',
		...rows,
		'ZZZZZZZZZZZZ',
		'</pre></p>',
		'<html><body></body></html>'
	].join('\n');
}

/** One row as DWS prints it. */
export const row = (day: string, flow: string, code: string) => `${day.replaceAll('-', '')}${flow.padStart(10)}${code.padStart(6)}`;

export type Reply = { status: number; body?: string; headers?: Record<string, string> };

/** A fake DWS: each request is answered by `answer(station, from, to, headers)`, and every request is recorded. */
export function fakeDws(answer: (q: { station: string; from: string; to: string; headers: Record<string, string> }) => Reply) {
	const requests: { station: string; from: string; to: string; headers: Record<string, string> }[] = [];
	const fetch = (async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
		const q = { station: (url.searchParams.get('Station') ?? '').replace(/100\.00$/, ''), from: url.searchParams.get('StartDT') ?? '', to: url.searchParams.get('EndDT') ?? '', headers };
		requests.push(q);
		const r = answer(q);
		return new Response(r.body ?? null, { status: r.status, headers: r.headers ?? {} });
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}

/** A clock the tests move by hand; sleep moves it rather than waiting. */
export function clock(startIso: string) {
	let t = Date.parse(startIso);
	return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

export interface TestRun {
	ctx: RunContext;
	store: MemoryStore;
	logs: { level: string; fields: Record<string, unknown> }[];
	lags: (number | null)[];
	time: ReturnType<typeof clock>;
}

/** A run context over a MemoryStore holding this station list, with the fake DWS and a 15-minute budget. */
export function testRun(o: { stations?: string[] | null; fetch: typeof globalThis.fetch; at?: string; store?: MemoryStore; remainingMs?: number }): TestRun {
	const time = clock(o.at ?? '2010-04-01T04:00:00Z');
	const store = o.store ?? new MemoryStore();
	if (o.stations !== null && !store.objects.has(KEYS.stations)) {
		void store.put(KEYS.stations, JSON.stringify({ v: 1, at: '2010-01-01T00:00:00Z', stations: o.stations ?? ['X0H001'] }), { contentType: 'application/json' });
		store.writes.length = 0;
	}
	const logs: TestRun['logs'] = [];
	const lags: (number | null)[] = [];
	const log: Log = (level, fields) => void logs.push({ level, fields });
	const remainingMs = o.remainingMs ?? 900_000;
	const client = new PoliteClient({ now: time.now, sleep: time.sleep, fetch: o.fetch });
	const ctx: RunContext = { store, client, now: time.now, deadline: time.now() + remainingMs - 30_000, remainingMs, log, emitLag: (l) => void lags.push(l) };
	return { ctx, store, logs, lags, time };
}
