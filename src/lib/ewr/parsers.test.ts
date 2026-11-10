import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTab, parseRevised, ewrLines, toCumec, nearestEc, parseDelimited, detectLayout, buildFlow, meanMonthly, ymKey, monthStatus, dailyMeans, cellNumber, parseDate, dayRows, gaugeDays, gaugeFlow, gaugeReadings, gaugeSeries, isCoded, isDay, isMon, monRows, parseDay, parseFactor, parseMon, parseReadings } from './parsers.ts';
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

test('text matrix: a # month has no value, other flags are ignored, gaps stay as gaps', () => {
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
  assert.equal(get(2000, 10), null);
  assert.equal(get(2001, 1), 4);
  assert.equal(get(2001, 11), null);
  assert.equal(get(2001, 12), 3.5);
  const mm = meanMonthly(f.records, ymKey(2000, 10), ymKey(2002, 9));
  assert.equal(mm[0].mean, 1.5);
  assert.equal(mm[0].n, 1);
  assert.equal(mm[1].n, 1);
  assert.equal(f.months, 22);
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
  assert.equal(cellNumber('12.34#'), null);
  assert.equal(cellNumber('12.34 #'), null);
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

// A .mon cell is nine characters: a space, the value in six, a quality code and the # flag.
const monCell = (value: string, flag = ' ', quality = ' ') => ` ${value.padStart(6)}${quality}${flag}`;
const monLine = (label: string, cells: string[], total: string) => `${label}${cells.join('')}${total}`;
const twelve = (first: string[]) => [...first, ...Array.from({ length: 12 - first.length }, () => monCell('1.00'))];
const MON = [
  'Format of the data is as follows :(I4,X,I4,13(X,A6,A1,A1) where:',
  'MONTHLY VOLUMES X0H001',
  'I4,X,I4,13(X,A6,A1,A1)',
  monLine('2000/2001', twelve([monCell('2.00'), monCell('4.00', '#'), monCell('', '#'), monCell('0.000')]), '    #'),
  monLine('2001/2002', twelve([monCell('3.00', ' ', 'E'), monCell('6.00')]), '    20.1'),
  monLine('2002/2003', twelve([monCell('', ' ')]), '   12.5 #'),
  'ZZZZZZZZZZ',
].join('\r\n');

test('.mon: reads the fixed widths, keeping flagged figures and quality codes', () => {
  assert.ok(isMon(MON));
  assert.ok(!isMon('Station X0H001 monthly volumes'));
  const r = parseMon(MON);
  assert.equal(r.station, 'X0H001');
  assert.deepEqual(r.years.map((y) => [y.label, y.start]), [['2000/2001', 2000], ['2001/2002', 2001], ['2002/2003', 2002]]);
  assert.deepEqual(r.years[0].months.slice(0, 4), [
    { v: 2, quality: '', incomplete: false },
    { v: 4, quality: '', incomplete: true },
    { v: null, quality: '', incomplete: true },
    { v: 0, quality: '', incomplete: false },
  ]);
  assert.equal(r.years[1].months[0].quality, 'E');
  assert.deepEqual([r.years[0].total.v, r.years[0].total.incomplete], [null, true]);
  assert.deepEqual([r.years[1].total.v, r.years[1].total.incomplete], [20.1, false]);
  assert.deepEqual([r.years[2].total.v, r.years[2].total.incomplete], [12.5, true]);
});

test('.mon: a blank month is incomplete even with no flag', () => {
  assert.equal(parseMon(MON).years[2].months[0].incomplete, true);
});

test('.mon: refuses what it cannot read', () => {
  assert.throws(() => parseMon('2000/2001 1 2 3'), /title is missing/);
  assert.throws(() => parseMon('MONTHLY VOLUMES X0H001\nZZZ'), /no year rows/);
  assert.throws(() => parseMon(`MONTHLY VOLUMES X0H001\n${monLine('2000/2001', twelve([monCell('abc')]), '    1')}`), /"abc" is not a volume, Oct 2000\/2001/);
});

test('gauge flow: flagged months are left out of the mean, a true zero stays in', () => {
  const f = gaugeFlow(parseMon(MON));
  const get = (y: number, m: number) => f.records.find((r) => r.y === y && r.m === m)!.v;
  assert.equal(get(2000, 10), 2);
  assert.equal(get(2000, 11), null);
  assert.equal(get(2000, 12), null);
  assert.equal(get(2001, 1), 0);
  assert.equal(get(2001, 9), 1);
  assert.equal(get(2001, 10), 3);
  assert.deepEqual([f.first!.y, f.first!.m, f.last!.y, f.last!.m], [2000, 10, 2003, 9]);
  const mm = meanMonthly(f.records, 0, Infinity);
  assert.deepEqual([mm[0].mean, mm[0].n], [2.5, 2]);
  assert.deepEqual([mm[1].mean, mm[1].n], [3.5, 2]);
  assert.deepEqual([mm[3].mean, mm[3].n], [2 / 3, 3]);
  assert.equal(f.months + f.missing, 36);
});

test('gauge flow: the factor scales every value, and so every mean', () => {
  const mm = meanMonthly(gaugeFlow(parseMon(MON), 0.5).records, 0, Infinity);
  assert.equal(mm[0].mean, 1.25);
  assert.equal(mm[1].mean, 1.75);
});

test('a .mon as a table leaves flagged months blank', () => {
  const rows = monRows(parseMon(MON));
  assert.deepEqual(rows[0].slice(0, 3), ['Year', 'Oct', 'Nov']);
  assert.deepEqual(rows[1].slice(0, 5), [2000, 2, null, null, 0]);
});

test('a factor must be a positive number', () => {
  assert.equal(parseFactor('0.85'), 0.85);
  assert.equal(parseFactor('2'), 2);
  for (const bad of ['', ' ', '0', '-1', 'abc', 'Infinity']) assert.equal(parseFactor(bad), null, bad);
});

const dayRow = (date: string, v: string, code: string) => `${date}${v.padStart(10)}${code.padStart(6)}`;
const DAILY = [
  'POS. 20-24  = Quality code',
  'DATE     D AVG F/R  QUAL',
  dayRow('20030103', '3.000', '1'),
  dayRow('20030101', '1.000', '1'),
  dayRow('20030102', '', '170'),
  dayRow('20030104', '4.000', '91'),
  dayRow('20030101', '1.500', '2'),
  dayRow('20030105', '9.000', '170'),
  'ZZZZZZZZZZZZ',
].join('\r\n');
const jan = (d: number) => Date.UTC(2003, 0, d);

test('.day: reads the fixed positions in date order, a repeated day replaced by its later row', () => {
  assert.ok(isDay(DAILY));
  assert.ok(!isDay('Date,Flow'));
  assert.deepEqual(parseDay(DAILY), [
    { t: jan(1), v: 1.5, code: '2' },
    { t: jan(2), v: null, code: '170' },
    { t: jan(3), v: 3, code: '1' },
    { t: jan(4), v: 4, code: '91' },
    { t: jan(5), v: null, code: '170' },
  ]);
});

test('.day: refuses what it cannot read', () => {
  assert.throws(() => parseDay('DATE     D AVG F/R  QUAL'), /no dated rows/);
  assert.throws(() => parseDay(dayRow('20030101', 'abc', '1')), /"abc" is not a flow, 20030101/);
});

test('only 1, 2 and no code are clean: any other code marks a real value', () => {
  for (const code of ['', '1', '2', undefined]) assert.equal(isCoded(code), false, String(code));
  for (const code of ['7', '50', '60', '64', '70', '91', '140']) assert.equal(isCoded(code), true, code);
});

test('dailyMeans keeps a day\'s code, a coded one first', () => {
  const t = jan(1);
  assert.deepEqual(dailyMeans([{ t, v: 1, code: '1' }, { t: t + 1, v: 3, code: '91' }, { t: t + 2, v: 2, code: '2' }]), [{ t, mean: 2, n: 3, code: '91' }]);
  assert.deepEqual(dailyMeans([{ t, v: 1 }]), [{ t, mean: 1, n: 1 }]);
});

test('gauge series: missing days have no flow, the record wins a day, the factor scales everything', () => {
  const daily = parseDay(DAILY);
  const readings = [{ t: jan(3), v: 100 }, { t: jan(6), v: 2 }, { t: jan(6) + 1, v: 4 }];
  const s = gaugeSeries({ daily, readings }, 0.5);
  assert.deepEqual(s.days, [
    { t: jan(1), mean: 0.75, n: 1, code: '2' },
    { t: jan(3), mean: 1.5, n: 1, code: '1' },
    { t: jan(4), mean: 2, n: 1, code: '91' },
    { t: jan(6), mean: 1.5, n: 2 },
  ]);
  assert.equal(s.missing, 2);
  assert.deepEqual(s.readings.map((p) => p.v), [50, 1, 2]);
});

test('gauge days are the daily record alone, and gauge readings the readings alone with their daily means', () => {
  const daily = parseDay(DAILY);
  const readings = [{ t: jan(3), v: 100 }, { t: jan(6), v: 2 }, { t: jan(6) + 1, v: 4 }];
  const d = gaugeDays({ daily, readings }, 0.5);
  assert.deepEqual(d.days, [
    { t: jan(1), mean: 0.75, n: 1, code: '2' },
    { t: jan(3), mean: 1.5, n: 1, code: '1' },
    { t: jan(4), mean: 2, n: 1, code: '91' },
  ]);
  assert.equal(d.missing, 2);
  assert.deepEqual(d.readings, []);
  const r = gaugeReadings({ daily, readings }, 0.5);
  assert.deepEqual(r.days, [{ t: jan(3), mean: 50, n: 1 }, { t: jan(6), mean: 1.5, n: 2 }]);
  assert.deepEqual(r.readings.map((p) => p.v), [50, 1, 2]);
  assert.equal(r.missing, 0);
});

test('readings as stored for a gauge', () => {
  const pts = parseReadings('Date,Time,Flow (m3/s)\n2025-11-15,02:24:00,0.035\n2025-11-15,02:36:00,0.037\n');
  assert.deepEqual(pts, [{ t: Date.UTC(2025, 10, 15, 2, 24), v: 0.035 }, { t: Date.UTC(2025, 10, 15, 2, 36), v: 0.037 }]);
});

test('dated rows with a quality column keep the code, and 170 has no flow even with a figure', () => {
  const rows = [['Date', 'Flow (m3/s)', 'Qual'], ['2003-01-01', 1, '91'], ['2003-01-02', 2, 170], ['2003-01-03', 3, '']];
  const f = buildFlow(rows, null, detectLayout(rows)!, { unit: 'cumec' });
  assert.deepEqual(f.points, [
    { t: jan(1), v: 1, code: '91' },
    { t: jan(2), v: null, code: '170' },
    { t: jan(3), v: 3 },
  ]);
});

test('a .day as a table reads back with its unit', () => {
  const rows = dayRows(parseDay(DAILY));
  assert.equal(detectLayout(rows)!.unit, 'cumec');
  assert.equal(detectLayout(rows)!.qualCol, 2);
});

const TABLE = [
  'File Name : x0h001.mon   (from daily file : x0h001.day, dated: )',
  'Units     : M.m3',
  '',
  'Year      Oct      Nov      Dec      Jan      Feb      Mar      Apr      May      Jun      Jul      Aug      Sep',
  '-'.repeat(112),
  '2000    3.890+   1.000    2.000    3.000    4.000    5.000    6.000    7.000    8.000    9.000   10.000   11.000',
  '2001    2.000    0.000    4.000    5.000  -99.999  -99.999  -99.999  -99.999  -99.999  -99.999  -99.999  -99.999',
].join('\r\n');

test('monthly table: the year is that of October, + is a patched value that counts, -99.999 is flagged, and no total is invented', () => {
  assert.ok(isMon(TABLE));
  const r = parseMon(TABLE);
  assert.equal(r.station, 'X0H001');
  assert.deepEqual(r.years.map((y) => [y.label, y.start]), [['2000', 2000], ['2001', 2001]]);
  assert.deepEqual(r.years[0].months[0], { v: 3.89, quality: '+', incomplete: false });
  assert.deepEqual(r.years[0].months[1], { v: 1, quality: '', incomplete: false });
  assert.deepEqual(r.years[1].months[4], { v: null, quality: '', incomplete: true });
  assert.equal(r.years[0].total.v, null);
  const f = gaugeFlow(r);
  assert.equal(f.records.find((x) => x.y === 2000 && x.m === 10)!.v, 3.89);
  assert.equal(f.records.find((x) => x.y === 2001 && x.m === 1)!.v, 3);
  assert.deepEqual([f.first!.y, f.first!.m, f.last!.y, f.last!.m], [2000, 10, 2002, 1]);
});

test('a month the daily record says is incomplete is flagged, keeping its figure, in either format', () => {
  const r = parseMon(TABLE, ['2001-11']);
  assert.deepEqual(r.years[1].months[1], { v: 0, quality: '', incomplete: true });
  assert.equal(gaugeFlow(r).records.find((x) => x.y === 2001 && x.m === 11)!.v, null);
  assert.equal(parseMon(MON, ['2001-01']).years[0].months[3].incomplete, true);
  assert.equal(parseMon(TABLE, ['2000-10']).years[0].months[0].incomplete, false);
});

test('monthly table: a short row is refused, not shifted', () => {
  assert.throws(() => parseMon(TABLE.replace('   11.000', '')), /11 months in the 2000 row/);
});
