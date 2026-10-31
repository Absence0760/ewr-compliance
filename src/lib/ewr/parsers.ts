// File parsers and flow arithmetic. No DOM access, so this runs anywhere.
import type {
  Cell, DayMean, EwrLines, Flow, FlowPoint, FlowStep, FlowUnit, Layout, LineInput, MonthMean, MonthRecord, MonthState,
  ParsedRevised, ParsedTab, YearIs,
} from './types.ts';

export const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
// The month lengths the Reserve figures are worked in, with February always 28 days.
export const DAYS = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30];
export const LADDER = ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D', 'D/E', 'E'];
export const PERCENTILES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

const blank = (): (number | null)[] => new Array(12).fill(null);

export const toCumec = (mm3: number | null, i: number): number | null => (mm3 === null ? null : (mm3 * 1e6) / (DAYS[i] * 86400));
export const toMm3 = (cumec: number | null, i: number): number | null => (cumec === null ? null : (cumec * DAYS[i] * 86400) / 1e6);
const MONTH_IDX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

// ---- Reserve Desktop outputs ---------------------------------------------

export function parseTab(text: string): ParsedTab {
  const num = (re: RegExp) => {
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  const low = blank(), drought = blank(), total = blank(), natural = blank();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)\s+(.+)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    if (v.length < 7 || v.some(Number.isNaN)) continue;
    const i = MONTH_IDX[m[1]];
    natural[i] = v[0];
    low[i] = v[3];
    drought[i] = v[4]; // 5th data column: Low Flows Drought
    total[i] = v[v.length - 1]; // last column: Total Flows Maint.
  }
  if (total.some((v) => v === null)) throw new Error('.tab file has no complete monthly table');
  const ec = text.match(/Ecological Category\s*=\s*([A-E/]+)/);
  return {
    ec: ec ? ec[1] : '', natural, low, drought, total,
    mar: num(/MAR\s*=\s*([\d.]+)/), totalIfr: num(/Total IFR\s*=\s*([\d.]+)/),
    totalPct: num(/Total IFR\s*=\s*[\d.]+\s*\(\s*([\d.]+)/),
    distribution: (text.match(/Distribution Type\s*:\s*(.+)/) || [, ''])[1].trim(),
  };
}

const PRESENT_DAY = 'EWR (low and total Flows) are constrained to be below Present Day Flows';

/** Revised Desktop .rul: the Total Flow Assurance tables in the Present Day section. */
export function parseRevised(text: string): ParsedRevised {
  const start = text.indexOf(PRESENT_DAY);
  if (start < 0) throw new Error('Not a Revised Desktop file: the Present Day section header is missing');
  const head = text.indexOf('Category Total Flow Assurance curves', start);
  if (head < 0) throw new Error('Category Total Flow Assurance curves header not found');
  const tables: Record<string, number[][]> = {};
  let ec: string | null = null;
  for (const line of text.slice(head).split(/\r?\n/).slice(1)) {
    const cat = line.match(/^\s*([A-E](?:\/[A-E])?) Category\s*$/);
    if (cat) {
      ec = cat[1];
      tables[ec] = new Array(12).fill(null) as number[][];
      continue;
    }
    const m = line.match(/^\s*(Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)\s+(.+)$/);
    if (m && ec) tables[ec][MONTH_IDX[m[1]]] = m[2].trim().split(/\s+/).map(Number);
    else if (/^[A-Z]{3,}/.test(line.trim())) break;
  }
  for (const [k, t] of Object.entries(tables)) {
    if (t.some((r) => !r || r.length !== PERCENTILES.length)) throw new Error(`Incomplete assurance table for ${k}`);
  }
  if (!Object.keys(tables).length) throw new Error('No category tables after the assurance header');
  const site = text.match(/outputs for site:\s*(\S+)/);
  return { site: site ? site[1] : '', tables };
}

// Urgent action required is 10% below the EWR line, for both methods.
const withUrgent = (ewr: number[], drought: number[]): EwrLines => ({ ewr, drought, urgent: ewr.map((v) => v * 0.9) });

/** The lines for the compliance graphic, always in Mm3, Oct first. */
export function ewrLines({ tab, revised, ec, percentile = 50, droughtPercentile = 90 }: LineInput): EwrLines {
  if (tab) return withUrgent(tab.total as number[], tab.drought as number[]);
  if (!revised || !ec) throw new Error('Nothing to draw: no .tab and no Revised table');
  const t = revised.tables[ec];
  if (!t) throw new Error(`No ${ec} table in this file`);
  const col = (p: number) => t.map((row) => row[PERCENTILES.indexOf(p)]);
  return withUrgent(col(percentile), col(droughtPercentile));
}

export function nearestEc(want: string, available: string[]): string {
  if (!available.length) return '';
  if (available.includes(want)) return want;
  const w = LADDER.indexOf(want);
  if (w < 0) return available[0];
  // Ties go to the higher category: the larger EWR is the precautionary reading.
  return [...available].sort((a, b) =>
    Math.abs(LADDER.indexOf(a) - w) - Math.abs(LADDER.indexOf(b) - w) || LADDER.indexOf(a) - LADDER.indexOf(b))[0];
}

// ---- Observed flow import ------------------------------------------------

const MONTH_WORDS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function monthWord(cell: unknown): number {
  if (typeof cell !== 'string') return 0;
  const s = cell.trim().toLowerCase().replace(/\.$/, '');
  if (s.length < 3 || s.length > 9) return 0;
  const m = MONTH_WORDS[s.slice(0, 3)];
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  return m && (s.length === 3 || s === 'sept' || full[m - 1] === s) ? m : 0;
}

/** Value from a cell, ignoring DWS-style quality flags such as 12.34# or 0.56 A. */
export function cellNumber(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== 'string') return null;
  const m = cell.trim().match(/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?(?=[^\d.]*$)/);
  return m ? parseFloat(m[0]) : null;
}
const clean = (v: number | null) => (v === null || v < 0 ? null : v); // -9999 style gaps

export function parseDelimited(text: string): { rows: Cell[][]; widths: number[][] | null } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const sample = lines.filter((l) => l.trim()).slice(0, 60);
  // A delimiter counts when most lines use it, so a short CSV is read as well as a long one.
  const share = (d: string) => sample.filter((l) => l.includes(d)).length / (sample.length || 1);
  const delim = (['\t', ';', ','] as const).find((d) => share(d) >= 0.6);
  if (delim) {
    return { rows: lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''))), widths: null };
  }
  // Whitespace columns: keep token positions so a blank month does not shift the row.
  const widths: number[][] = [];
  const rows = lines.map((l) => {
    const toks = [...l.matchAll(/\S+/g)];
    widths.push(toks.map((t) => t.index! + t[0].length));
    return toks.map((t) => t[0]);
  });
  return { rows, widths };
}

function yearOf(cell: unknown): number | null {
  const n = cellNumber(cell);
  if (n !== null && (typeof cell === 'number' || /^\d{4}$/.test(String(cell).trim()))) {
    return n >= 1800 && n <= 2200 && Number.isInteger(n) ? n : null;
  }
  const m = String(cell ?? '').trim().match(/^(\d{4})\s*[/-]\s*(\d{2,4})$|^(\d{4})(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1] || m[3], 10);
}

const excelDate = (serial: number) => Math.round((serial - 25569) * 86400000); // UTC ms, 1900 date system

/** A date cell to UTC ms. Local clock time is kept as written, with no timezone applied. */
export function parseDate(cell: unknown): number | null {
  if (typeof cell === 'number') return cell > 15000 && cell < 80000 ? excelDate(cell) : null;
  if (cell instanceof Date) return cell.getTime();
  if (typeof cell !== 'string') return null;
  const s = cell.trim();
  let m: RegExpMatchArray | null;
  const hms = (h?: string, mi?: string, se?: string) => (parseInt(h || '0', 10) * 3600 + parseInt(mi || '0', 10) * 60 + parseInt(se || '0', 10)) * 1000;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) + hms(m[4], m[5], m[6]);
  }
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
    return Date.UTC(+m[3], +m[2] - 1, +m[1]) + hms(m[4], m[5], m[6]); // SA day-first
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{4})[-/]?(\d{2})$/)) && +m[2] <= 12 && +m[2] >= 1) return Date.UTC(+m[1], +m[2] - 1, 1);
  if ((m = s.match(/^([A-Za-z]{3,9})[-\s/]+(\d{2,4})$/)) && monthWord(m[1])) {
    const y = +m[2] < 100 ? (+m[2] > 40 ? 1900 : 2000) + +m[2] : +m[2];
    return Date.UTC(y, monthWord(m[1]) - 1, 1);
  }
  return null;
}

function timeFraction(cell: unknown): number | null {
  if (typeof cell === 'number') return cell >= 0 && cell < 1 ? Math.round(cell * 86400) * 1000 : null;
  if (typeof cell === 'string') {
    const m = cell.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) * 1000;
  }
  return null;
}

function detectUnit(texts: string[]): FlowUnit | '' {
  const t = texts.join(' ').toLowerCase().replace(/[\s^³]/g, (c) => (c === '³' ? '3' : ''));
  if (/m3\/s|cumec|m3s-?1|cubicmet(re|er)spersecond/.test(t)) return 'cumec';
  if (/mm3|mcm|mill(ion)?\.?(cu|m3|cubic)|10\^?6m3/.test(t)) return 'mm3';
  return '';
}

function findMatrix(rows: Cell[][], widths: number[][] | null): Layout | null {
  for (let r = 0; r < Math.min(rows.length, 80); r++) {
    const months = rows[r].map(monthWord);
    if (months.filter(Boolean).length < 11) continue;
    const yearRows = rows.slice(r + 1).filter((row) => row.slice(0, 2).some((c) => yearOf(c) !== null)).length;
    if (!yearRows) continue;
    const cols = months.map((m, c) => ({ m, c })).filter((x) => x.m);
    const yearCol = yearColumn(rows, r);
    return { kind: 'matrix', headerRow: r, yearCol, cols, firstMonth: cols[0].m, unit: '', title: '' };
  }
  return null;
}

function yearColumn(rows: Cell[][], header: number): number {
  for (let c = 0; c < 3; c++) {
    if (rows.slice(header + 1, header + 8).some((row) => yearOf(row[c]) !== null)) return c;
  }
  return 0;
}

function findSeries(rows: Cell[][]): Layout | null {
  const flowRe = /flow|discharge|volume|m\^?3|cumec|mcm|\bq\b/i;
  const skipRe = /stage|level|qual|flag|date|time|ewr|day/i;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const heads: string[] = rows[r].map((c) => (typeof c === 'string' ? c.trim() : ''));
    const lower = heads.map((h) => h.toLowerCase());
    const yc = lower.findIndex((h) => h === 'year' || h === 'yr');
    const mc = lower.findIndex((h) => h === 'month' || h === 'mon');
    const dc = lower.findIndex((h) => /^(date|datetime|date\s*\/?\s*time|timestamp|period|month)\b/.test(h));
    const vc = heads.findIndex((h, i) => flowRe.test(h) && !skipRe.test(h) && i !== dc);
    if (yc >= 0 && mc >= 0) {
      // JSON keys come in any order, so the next column after the month can be the year.
      const probe = rows.slice(r + 1, r + 10);
      const other = heads.findIndex((h, i) => i !== yc && i !== mc && !skipRe.test(h) && probe.some((row) => cellNumber(row[i]) !== null));
      const v = vc >= 0 ? vc : other;
      return { kind: 'series', headerRow: r, yearCol: yc, monthCol: mc, valueCol: v, unitHint: detectUnit([heads[v] || '']), unit: '', title: '' };
    }
    if (dc >= 0) {
      const tc = lower.findIndex((h, i) => i !== dc && /^time\b/.test(h));
      let v = vc;
      if (v < 0) {
        const probe = rows.slice(r + 1, r + 10);
        v = heads.findIndex((h, i) => i !== dc && i !== tc && !skipRe.test(h) &&
          probe.some((row) => cellNumber(row[i]) !== null));
      }
      if (v >= 0) return { kind: 'series', headerRow: r, dateCol: dc, timeCol: tc, valueCol: v, unitHint: detectUnit([heads[v]]), unit: '', title: '' };
    }
  }
  // No header: first column is a date, next numeric column is the value.
  const first = rows.findIndex((row) => row.length >= 2 && typeof row[0] === 'string' && parseDate(row[0]) !== null);
  if (first >= 0) {
    // Column 2 is a time only if a value follows it: a flow under 1 m3/s also looks like a day fraction.
    const hasTime = timeFraction(rows[first][1]) !== null && cellNumber(rows[first][2]) !== null;
    return { kind: 'series', headerRow: first - 1, dateCol: 0, timeCol: hasTime ? 1 : -1,
      valueCol: hasTime ? 2 : 1, unitHint: '', unit: '', title: '' };
  }
  return null;
}

/** Work out how a table is laid out. Returns null when no flow data is recognised. */
export function detectLayout(rows: Cell[][], widths: number[][] | null = null): Layout | null {
  const layout = findMatrix(rows, widths) || findSeries(rows);
  if (!layout) return null;
  const preface = rows.slice(0, Math.max(layout.headerRow + 1, 0)).flat().filter((c): c is string => typeof c === 'string');
  layout.unit = layout.unitHint || detectUnit(preface) || '';
  layout.title = preface.slice(0, 12).join(' ').slice(0, 120);
  return layout;
}

function matrixRecords(rows: Cell[][], widths: number[][] | null, L: Layout, yearIs: YearIs): MonthRecord[] {
  const recs: MonthRecord[] = [];
  const headerEnds = widths ? widths[L.headerRow] : null;
  const hydro = L.firstMonth !== 1;
  for (let r = L.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const y = yearOf(row[L.yearCol!]);
    if (y === null) continue;
    let cells: Record<number, Cell> | undefined;
    if (headerEnds && row.length < rows[L.headerRow].length) {
      // Short row: match each token to the month column whose right edge it sits under.
      const placed: Record<number, Cell> = {};
      cells = placed;
      row.forEach((tok, i) => {
        if (i === L.yearCol) return;
        const end = widths![r][i];
        let best: { d: number; c: number } | null = null;
        for (const col of L.cols!) {
          const d = Math.abs(headerEnds[col.c] - end);
          if (best === null || d < best.d) best = { d, c: col.c };
        }
        if (best) placed[(best as { c: number }).c] = tok;
      });
    }
    for (const { m, c } of L.cols!) {
      const v = clean(cellNumber(cells ? cells[c] : row[c]));
      const base: number = hydro && yearIs === 'end' ? y - 1 : y;
      const year = hydro && m < L.firstMonth! ? base + 1 : base;
      recs.push({ y: year, m, v });
    }
  }
  return recs;
}

function seriesPoints(rows: Cell[][], L: Layout): FlowPoint[] {
  const pts: FlowPoint[] = [];
  for (let r = L.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    let t: number | null = null;
    if (L.yearCol !== undefined) {
      const y = cellNumber(row[L.yearCol]);
      const m = monthWord(row[L.monthCol!]) || cellNumber(row[L.monthCol!]);
      if (y && m && m >= 1 && m <= 12) t = Date.UTC(y, m - 1, 1);
    } else {
      t = parseDate(row[L.dateCol!]);
      if (t !== null && L.timeCol! >= 0) t += timeFraction(row[L.timeCol!]) ?? 0;
    }
    if (t === null) continue;
    pts.push({ t, v: clean(cellNumber(row[L.valueCol!])) });
  }
  return pts.sort((a, b) => a.t - b.t);
}

function cadence(pts: FlowPoint[]): FlowStep {
  const gaps: number[] = [];
  for (let i = 1; i < pts.length && gaps.length < 500; i++) {
    const g = pts[i].t - pts[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 'monthly';
  gaps.sort((a, b) => a - b);
  const day = gaps[gaps.length >> 1] / 86400000;
  return day < 0.9 ? 'instantaneous' : day < 5 ? 'daily' : 'monthly';
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Turn rows + layout into observed flow.
 *   unit:   'mm3' | 'cumec', what the values are in
 *   yearIs: 'start' | 'end', how a plain year labels an Oct-Sep row
 * Monthly volumes are kept for the Historical Comparison; sub-monthly data also
 * keeps its points for the Real Time Comparison.
 */
export function buildFlow(rows: Cell[][], widths: number[][] | null, layout: Layout, { unit, yearIs = 'start' }: { unit: FlowUnit; yearIs?: YearIs }): Flow {
  let records: MonthRecord[], points: FlowPoint[] | null = null, step: FlowStep = 'monthly';
  if (layout.kind === 'matrix') {
    records = matrixRecords(rows, widths, layout, yearIs);
    if (unit === 'cumec') {
      records = records.map((r) => ({ ...r, v: r.v === null ? null : (r.v * daysIn(r.y, r.m) * 86400) / 1e6 }));
    }
  } else {
    const pts = seriesPoints(rows, layout);
    step = cadence(pts);
    if (step === 'monthly') {
      records = pts.map((p) => {
        const d = new Date(p.t);
        const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
        const v = p.v === null ? null : unit === 'cumec' ? (p.v * daysIn(y, m) * 86400) / 1e6 : p.v;
        return { y, m, v };
      });
    } else {
      points = pts;
      records = monthlyFromPoints(pts, unit);
    }
  }
  records.sort((a, b) => a.y - b.y || a.m - b.m);
  const present = records.filter((r) => r.v !== null);
  return {
    records, points, step, unit,
    first: present[0] || null, last: present[present.length - 1] || null,
    months: present.length, missing: records.length - present.length,
  };
}

function monthlyFromPoints(pts: FlowPoint[], unit: FlowUnit): MonthRecord[] {
  const groups = new Map<number, { sum: number; n: number; days: Set<number> }>();
  for (const p of pts) {
    if (p.v === null) continue;
    const d = new Date(p.t);
    const k = d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
    if (!groups.has(k)) groups.set(k, { sum: 0, n: 0, days: new Set() });
    const g = groups.get(k)!;
    g.sum += p.v;
    g.n++;
    g.days.add(d.getUTCDate());
  }
  const out: MonthRecord[] = [];
  for (const [k, g] of groups) {
    const y = Math.floor(k / 100), m = k % 100, dim = daysIn(y, m);
    // A month with under 80% of its days gets no volume rather than a partial one.
    const complete = g.days.size >= 0.8 * dim;
    const mean = g.sum / g.n;
    out.push({ y, m, v: !complete ? null : unit === 'mm3' ? g.sum : (mean * dim * 86400) / 1e6 });
  }
  return out;
}

// ---- Comparisons -----------------------------------------------------------

export const ymKey = (y: number, m: number) => y * 12 + (m - 1);
export const monthIndex = (m: number) => (m + 2) % 12; // calendar month -> Oct-first index

/** Mean monthly flow in Mm3 for a period, Oct first, with the values behind each mean. */
export function meanMonthly(records: MonthRecord[], from: number, to: number): MonthMean[] {
  const buckets: number[][] = MONTHS.map(() => []);
  for (const r of records) {
    const k = ymKey(r.y, r.m);
    if (r.v === null || k < from || k > to) continue;
    buckets[monthIndex(r.m)].push(r.v);
  }
  return buckets.map((vals) => ({
    n: vals.length,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    values: vals,
  }));
}

export function monthStatus(mean: number | null, lines: Pick<EwrLines, 'ewr' | 'urgent' | 'drought'>, i: number): MonthState {
  if (mean === null) return { key: 'none', label: 'No data' };
  if (mean >= lines.ewr[i]) return { key: 'good', label: 'EWR met' };
  if (mean < lines.drought[i]) return { key: 'critical', label: 'Below Drought EWR' };
  if (mean < lines.urgent[i]) return { key: 'serious', label: 'Urgent action required' };
  return { key: 'warning', label: 'Below EWR' };
}

export const shareAtLeast = (values: number[], target: number) =>
  (values.length ? (100 * values.filter((v) => v >= target).length) / values.length : null);

/** Daily mean flow from instantaneous readings. */
export function dailyMeans(points: FlowPoint[]): DayMean[] {
  const days = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    if (p.v === null) continue;
    const k = Math.floor(p.t / 86400000);
    if (!days.has(k)) days.set(k, { sum: 0, n: 0 });
    const d = days.get(k)!;
    d.sum += p.v;
    d.n++;
  }
  return [...days].sort((a, b) => a[0] - b[0]).map(([k, d]) => ({ t: k * 86400000, mean: d.sum / d.n, n: d.n }));
}
