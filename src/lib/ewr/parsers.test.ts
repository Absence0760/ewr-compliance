import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTab, parseRevised, ewrLines, toCumec, nearestEc, parseDelimited, detectLayout, buildFlow, meanMonthly, ymKey, monthStatus, dailyMeans, cellNumber, parseDate } from './parsers.ts';
import type { Cell } from './types.ts';

// The synthetic dataset, read from its committed source so these tests need no `pnpm data:sample`.
// Its tables are in e2e/fixtures/make-sample-data.mjs, and the values below are hand arithmetic on them.
const load = (f: string) => JSON.parse(readFileSync(new URL(`../../../e2e/fixtures/sample-data/${f}`, import.meta.url), 'utf8'));
const index = load('index.json');
const stores: Record<string, Record<string, string>> = Object.fromEntries(['berg', 'breede', 'gouritz', 'olifantsdoring'].map((b) => [b, load(`ewr-${b}.json`)]));
const slug = (b: string) => b.toLowerCase().replace('-', '');

test('every .tab parses and revised files give seven categories', () => {
  let tabs = 0, rev = 0;
  for (const n of index.nodes) for (const f of n.files) {
    const text = stores[slug(n.basin)][f.name];
    if (f.kind === 'tab') { const t = parseTab(text); assert.equal(t.total.length, 12); tabs++; }
    if (f.kind === 'revised') {
      const r = parseRevised(text);
      assert.deepEqual(Object.keys(r.tables), ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D']);
      rev++;
    }
  }
  assert.equal(tabs, 10);
  assert.equal(rev, 2);
});

test('a .tab gives its Total Flows Maint. and Low Flows Drought columns', () => {
  const t = parseTab(stores.gouritz['SYT1D.tab']);
  assert.deepEqual(t.total, [2, 1.7, 1.3, 0.8, 0.56, 1.2, 0.9, 1, 1.4, 1.2, 4, 1.5]);
  assert.equal(t.drought[0], 1);
  assert.ok(Math.abs(toCumec(t.total[1], 1)! - 0.65586) < 1e-5); // Nov, 1.7 ÷ 2.592
});

test('a .tab gets Urgent action required 10% below its EWR', () => {
  const l = ewrLines({ tab: parseTab(stores.gouritz['SYT1D.tab']) });
  assert.ok(Math.abs(l.urgent[1] - 1.53) < 1e-9); // Nov, 1.7 × 0.9 Mm³
  assert.ok(Math.abs(toCumec(l.urgent[1], 1)! - 0.59028) < 1e-5); // 1.53 ÷ 2.592
  assert.ok(Math.abs(l.urgent[4] - 0.504) < 1e-9); // Feb, 0.56 × 0.9 Mm³
  assert.ok(Math.abs(toCumec(l.urgent[4], 4)! - 0.20833) < 1e-5); // 0.504 ÷ 2.4192, Feb 28 days
});

test('Revised reader uses the Present Day section, not the Natural one', () => {
  const r = parseRevised(stores.gouritz['syr1.rul(NEWFORM)']);
  // A Present Day cell in the B table is 0.19 × (12 - i) × (10 - j). The Natural tables hold 9.999.
  const l = ewrLines({ revised: r, ec: 'B', percentile: 50, droughtPercentile: 90 });
  assert.equal(l.ewr[0], 13.68); // Oct 50th, 0.19 × 12 × 6
  assert.equal(l.drought[3], 3.42); // Jan 90th, 0.19 × 9 × 2
  assert.equal(l.ewr[7], 5.7);     // May 50th, 0.19 × 5 × 6
  assert.ok(Math.abs(l.urgent![7] - 5.13) < 1e-9);
  assert.equal(ewrLines({ revised: r, ec: 'B', droughtPercentile: 99 }).drought[8], 0.76); // Jun 99th, 0.19 × 4 × 1
});

test('nearest EC prefers the exact EC, then the higher category on a tie', () => {
  assert.equal(nearestEc('C', ['B', 'C', 'D']), 'C');
  assert.equal(nearestEc('C/D', ['B', 'C', 'D']), 'C');
  assert.equal(nearestEc('E', ['B', 'C', 'D']), 'D');
  assert.equal(nearestEc('A/B', ['B', 'C']), 'B');
});

test('.mrv reads as a monthly matrix in hydrological years', () => {
  const g = load('series-gouritz.json');
  const { rows, widths } = parseDelimited(g['SYT1D.mrv']);
  const L = detectLayout(rows, widths)!;
  assert.equal(L.kind, 'matrix');
  const f = buildFlow(rows, widths, L, { unit: 'mm3' });
  assert.deepEqual([f.first!.y, f.first!.m, f.first!.v], [2001, 10, 0.01]);
  assert.deepEqual([f.records[3].y, f.records[3].m, f.records[3].v], [2002, 1, 0.04]);
  assert.equal(f.last!.y, 2004);
});

test('text matrix: flags are ignored, gaps stay as gaps', () => {
  const txt = ` Station X0H001   Monthly flow volume (million m3)
 YEAR    OCT     NOV     DEC     JAN     FEB     MAR     APR     MAY     JUN     JUL     AUG     SEP
 2000   1.000#  2.000   3.000   4.000+  5.000   6.000   7.000   8.000   9.000  10.000  11.000  12.000
 2001   1.500           3.500   4.500   5.500   6.500   7.500   8.500   9.500  10.500  11.500  12.500
 MEAN   1.250   2.000   3.250   4.250   5.250   6.250   7.250   8.250   9.250  10.250  11.250  12.250`;
  const { rows, widths } = parseDelimited(txt);
  const L = detectLayout(rows, widths)!;
  assert.equal(L.unit, 'mm3');
  const f = buildFlow(rows, widths, L, { unit: 'mm3' });
  const get = (y: number, m: number) => f.records.find((r) => r.y === y && r.m === m)!.v;
  assert.equal(get(2000, 10), 1);
  assert.equal(get(2001, 1), 4);
  assert.equal(get(2001, 11), null);
  assert.equal(get(2001, 12), 3.5);
  const mm = meanMonthly(f.records, ymKey(2000, 10), ymKey(2002, 9));
  assert.equal(mm[0].mean, 1.25);
  assert.equal(mm[1].n, 1);
  assert.equal(f.months, 23);
});

test('year labelled at the end of the hydrological year', () => {
  const rows = [['Year', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
    [2001, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]];
  const f = buildFlow(rows, null, detectLayout(rows)!, { unit: 'mm3', yearIs: 'end' });
  assert.deepEqual([f.first!.y, f.first!.m], [2000, 10]);
  assert.deepEqual([f.last!.y, f.last!.m], [2001, 9]);
});

test('spreadsheet-style long and calendar tables', () => {
  const cal = [['Yr', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    ['2010', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]];
  const f1 = buildFlow(cal, null, detectLayout(cal)!, { unit: 'mm3' });
  assert.equal(f1.records.find((r) => r.m === 10)!.y, 2010);
  const long = [['Date', 'Volume (Mm3)'], ['2010-10', 3], ['2010-11', 4], ['2010-12', 5]];
  const L2 = detectLayout(long)!;
  assert.equal(L2.unit, 'mm3');
  const f2 = buildFlow(long, null, L2, { unit: 'mm3' });
  assert.equal(f2.step, 'monthly');
  assert.deepEqual([f2.first!.y, f2.first!.m, f2.first!.v], [2010, 10, 3]);
  const ym = [['Year', 'Month', 'Flow (m3/s)'], [2010, 'Oct', 1]];
  const L3 = detectLayout(ym)!;
  assert.equal(L3.unit, 'cumec');
  assert.ok(Math.abs(buildFlow(ym, null, L3, { unit: 'cumec' }).first!.v! - 2.6784) < 1e-9);
  const mixed: Cell[][] = [['Month', 'Year', 'Quality', 'Value'], [10, 2010, 'A', 1.5]];
  assert.equal(buildFlow(mixed, null, detectLayout(mixed)!, { unit: 'mm3' }).first!.v, 1.5);
});

test('12-minute date/time/flow table with a title row', () => {
  const rows: Cell[][] = [['Synthetic gauge X0H001'], ['Date', 'Time', 'Stage(m)', 'Flow(m^3/s)']];
  const d0 = 45976; // 2025-11-15
  for (let i = 0; i < 240; i++) rows.push([d0 + Math.floor(i / 120), ((i % 120) * 12) / 1440, 0.02, 0.04 + (i >= 120 ? 0.02 : 0)]);
  const L = detectLayout(rows)!;
  assert.equal(L.unit, 'cumec');
  assert.equal(L.valueCol, 3);
  const f = buildFlow(rows, null, L, { unit: 'cumec' });
  assert.equal(f.step, 'instantaneous');
  const d = dailyMeans(f.points!);
  assert.equal(d.length, 2);
  assert.ok(Math.abs(d[1].mean - 0.06) < 1e-9);
  assert.equal(new Date(d[0].t).toISOString().slice(0, 10), '2025-11-15');
  assert.equal(f.records[0].v, null); // two days is not a month's volume
});

test('status bands', () => {
  const lines = { ewr: [1], urgent: [0.9], drought: [0.5] };
  assert.equal(monthStatus(1, lines, 0).key, 'good');
  assert.equal(monthStatus(0.95, lines, 0).key, 'warning');
  assert.equal(monthStatus(0.7, lines, 0).key, 'serious');
  assert.equal(monthStatus(0.4, lines, 0).key, 'critical');
  assert.equal(monthStatus(null, lines, 0).key, 'none');
});

test('status bands on a .tab', () => {
  const lines = ewrLines({ tab: parseTab(stores.gouritz['SYT1D.tab']) }); // Nov: 1.7, Urgent 1.53, Drought 0.9
  assert.equal(monthStatus(1.7, lines, 1).key, 'good');
  assert.equal(monthStatus(1.54, lines, 1).key, 'warning');
  assert.equal(monthStatus(1.52, lines, 1).key, 'serious');
  assert.equal(monthStatus(0.9, lines, 1).key, 'serious');
  assert.equal(monthStatus(0.899, lines, 1).key, 'critical');
});

test('no urgent band when Drought EWR is at or above the Urgent line', () => {
  const lines = { ewr: [1], urgent: [0.9], drought: [0.95] };
  assert.equal(monthStatus(0.97, lines, 0).key, 'warning');
  assert.equal(monthStatus(0.92, lines, 0).key, 'critical');
});

test('cell helpers', () => {
  assert.equal(cellNumber('12.34#'), 12.34);
  assert.equal(cellNumber('0.56 A'), 0.56);
  assert.equal(cellNumber('1990/91'), null);
  assert.equal(new Date(parseDate('15/11/2025 02:24')!).toISOString(), '2025-11-15T02:24:00.000Z');
  assert.equal(new Date(parseDate('Oct-90')!).toISOString().slice(0, 7), '1990-10');
});

test('a two-line CSV is split on its commas', () => {
  const { rows, widths } = parseDelimited('Date,Flow (m3/s)\n2025-11-15,0.04');
  assert.equal(widths, null);
  assert.deepEqual(rows[1], ['2025-11-15', '0.04']);
});

test('a headerless file reads a low flow as a value, not a time', () => {
  const { rows, widths } = parseDelimited('2025-11-15 0.04\n2025-11-16 0.05\n');
  const L = detectLayout(rows, widths)!;
  assert.equal(L.timeCol, -1);
  assert.equal(L.valueCol, 1);
  const withTime = [['2025-11-15', '02:24', '0.04']];
  const T = detectLayout(withTime)!;
  assert.equal(T.timeCol, 1);
  assert.equal(T.valueCol, 2);
});
