// Writes every fixture in this folder: `node e2e/fixtures/make-fixtures.mjs`. All of it is invented,
// by the plain formulas below, and none comes from a client file, so the repo can go public.
// Run it twice and the bytes are the same: nothing reads the clock or a random source. The specs
// do not import this: they hold their expected numbers as hand arithmetic on these formulas.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const round3 = (v) => Math.round(v * 1000) / 1000;

function writeBook(name, sheets) {
	const wb = XLSX.utils.book_new();
	for (const [sheet, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
	// Without this SheetJS stamps the file with the time it was written.
	wb.Props = { CreatedDate: new Date(0), ModifiedDate: new Date(0) };
	writeFileSync(here(name), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/**
 * 15 hydrological years, labelled by the year of October, 2005 to 2019. With k = 1 for 2005 up to
 * 15 for 2019, and i = 0 for Oct up to 11 for Sep, a month is k × (i + 1) × 0.1 Mm³.
 * One gap: Feb of hydrological year 2007 (k = 3) is blank.
 */
function monthlyRows() {
	const rows = [['Synthetic gauge X0X001: monthly flow volume (million m3)'], ['Year', ...MONTHS]];
	for (let k = 1; k <= 15; k++) {
		const values = MONTHS.map((_, i) => (k === 3 && i === 4 ? null : round3(k * (i + 1) * 0.1)));
		rows.push([2004 + k, ...values]);
	}
	return rows;
}

/** Excel serial for a readings sheet: 45990 is 2025-11-29. */
const SERIAL_29_NOV = 45990;
const READINGS_PER_DAY = 120; // 12-minute steps

/** One day of readings around a mean: odd readings 0.01 over it, even readings 0.01 under it. */
const reading = (mean, i) => round3(mean + (i % 2 ? 0.01 : -0.01));
const clock = (i) => `${String(Math.floor((i * 12) / 60)).padStart(2, '0')}:${String((i * 12) % 60).padStart(2, '0')}`;

/** Three days over a month end, with daily means of 0.500, 0.700 and 0.300 m³/s. */
function readingsCsv() {
	const lines = ['Synthetic gauge X0X002', 'Date,Time,Stage(m),Flow(m^3/s)'];
	[['2025-11-29', 0.5], ['2025-11-30', 0.7], ['2025-12-01', 0.3]].forEach(([day, mean]) => {
		for (let i = 0; i < READINGS_PER_DAY; i++) lines.push(`${day},${clock(i)},0.100,${reading(mean, i).toFixed(3)}`);
	});
	return `${lines.join('\n')}\n`;
}

/** Two days with daily means of 1.000 and 2.000 m³/s, as Excel date and time serials. */
function readingsSheet() {
	const rows = [['Synthetic gauge X0X003'], ['Date', 'Time', 'Stage(m)', 'Flow(m^3/s)']];
	[1, 2].forEach((mean, day) => {
		for (let i = 0; i < READINGS_PER_DAY; i++) rows.push([SERIAL_29_NOV + day, (i * 12) / 1440, 0.1, reading(mean, i)]);
	});
	return rows;
}

/** DWS-style text: right-aligned fixed columns, flags on some values, Nov 2017 blank. */
function monthlyText() {
	const pad = (s, w) => String(s).padStart(w);
	const header = ` YEAR${MONTHS.map((m) => pad(m.toUpperCase(), 9)).join('')}`;
	const flags = { '2016:0': '#', '2016:3': '+', '2018:0': 'A' };
	const row = (year, base) => {
		const cells = MONTHS.map((_, i) => {
			if (year === 2017 && i === 1) return pad('', 9);
			// Flags sit after the number, so the number keeps its place under the column.
			return pad(`${(base * (i + 1)).toFixed(3)}${flags[`${year}:${i}`] ?? ''}`, 9);
		});
		return ` ${year}${cells.join('')}`;
	};
	return [
		' Station X0X004   Synthetic monthly flow volume (million m3)',
		'',
		header,
		row(2016, 1),
		row(2017, 2),
		row(2018, 3),
		'',
		` MEAN${MONTHS.map((_, i) => pad((2 * (i + 1)).toFixed(3), 9)).join('')}`,
		''
	].join('\n');
}

/**
 * The parts of a Revised Desktop output the app reads, in its layout. A cell in the Present Day
 * tables is (7 - c) × (i + 1) × (10 - j) × 0.01 Mm³: c = 0 for category A up to 6 for D, i = 0 for
 * Oct, j = 0 for the 10th percentile up to 9 for the 99th. The Natural tables come first and
 * hold 9.999 throughout, so reading the wrong section shows at once.
 */
function revisedRul() {
	const CATEGORIES = ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D'];
	const percentiles = '          10%       20%       30%       40%       50%       60%       70%       80%       90%       99%';
	const table = (cell) =>
		CATEGORIES.flatMap((cat, c) => [
			`  ${cat} Category`,
			...MONTHS.map((m, i) => `${m}${Array.from({ length: 10 }, (_, j) => cell(c, i, j).toFixed(3).padStart(10)).join('')}`),
			' '
		]);
	const section = (over, cell) => [
		'FINAL RESERVE SUMMARY DETAILS',
		' ',
		`EWR (low and total Flows) are constrained to be below ${over} Flows`,
		' ',
		'Category Total Flow Assurance curves (mill. m3)',
		percentiles,
		' ',
		...table(cell)
	];
	return [
		'TITLE: Synthetic RDMR Report',
		'DATE: 01/01/2000',
		'',
		'Revised Desktop Model outputs for site: syn1',
		' ',
		...section('Natural', () => 9.999),
		...section('Present Day', (c, i, j) => (7 - c) * (i + 1) * (10 - j) * 0.01),
		''
	].join('\n');
}

writeBook('monthly.xlsx', [['Monthly flow', monthlyRows()]]);
writeBook('multi-sheet.xlsx', [
	['Notes', [['Synthetic workbook for the tests. The readings are on a later sheet.']]],
	['Monthly', monthlyRows()],
	['12 minute', readingsSheet()]
]);
writeFileSync(here('monthly-flagged.txt'), monthlyText());
writeFileSync(here('readings-12min.csv'), readingsCsv());
writeFileSync(here('junk.txt'), 'This is not a flow file.\nIt has no months, no dates and no numbers in columns.\n');
writeFileSync(here('revised.rul'), revisedRul());
