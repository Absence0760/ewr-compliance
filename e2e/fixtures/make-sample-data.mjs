// Writes the synthetic dataset in sample-data/: `node e2e/fixtures/make-sample-data.mjs`.
// `pnpm data:sample` then copies it to static/data, which is what CI and the public tests run on.
//
// All of it is invented here, by the tables and formulas below. Node codes, sites, rivers,
// quaternaries, coordinates, flows and percentages mean nothing, and none comes from a client file.
// Run it twice and the bytes are the same: nothing reads the clock or a random source. The specs do
// not import this: they hold their expected numbers as hand arithmetic on these tables.
//
// It has the same shape as the real static/data: index.json, and for each basin ewr-<slug>.json and
// series-<slug>.json, each mapping a file name to that file's text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('sample-data/', import.meta.url));
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const BASINS = { Berg: 'berg', Breede: 'breede', Gouritz: 'gouritz', 'Olifants-Doring': 'olifantsdoring' };
const round3 = (v) => Math.round(v * 1000) / 1000;
const pad = (v, w = 8) => v.toFixed(3).padStart(w);

/** Total Flows Maint. and Low Flows Drought at scale 1, Mm³, Oct first. EC D at syt1. */
const TOTAL = [2.0, 1.7, 1.3, 0.8, 0.56, 1.2, 0.9, 1.0, 1.4, 1.2, 4.0, 1.5];
const DROUGHT = [1.0, 0.9, 0.4, 0.1, 0.056, 0.2, 0.2, 0.3, 0.3, 0.5, 0.8, 0.9];

/** A Desktop output with both tables multiplied by `scale`. MAR is 100, so Total IFR % is its volume. */
function desktopFile({ node, ec, scale, pct = null, constructed = false }) {
	const total = TOTAL.map((v) => round3(v * scale));
	const drought = DROUGHT.map((v) => round3(v * scale));
	const sum = total.reduce((a, b) => a + b, 0);
	const share = pct ?? round3(sum);
	return [
		...(constructed ? [`        ${node} synthetic constructed run`, '        CONSTRUCTED'] : []),
		'        Synthetic Desktop output, invented for the tests',
		`        Total Runoff :           ${node}`,
		'',
		'        MAR               =  100.000',
		`        Ecological Category = ${ec}`,
		`        Total IFR         =  ${pad(sum, 7)} (${share.toFixed(2)} %MAR)`,
		'        Distribution Type : Synthetic',
		'',
		'        Month  Natural  SD  CV  Maint.  Drought  High  Total',
		...MONTHS.map((m, i) =>
			`         ${m}${pad(total[i] * 3)}${pad(total[i])}${pad(1)}${pad(total[i])}${pad(drought[i])}${pad(0)}${pad(total[i])}`
		),
		''
	].join('\n');
}

/**
 * The parts of a Revised Desktop output the app reads, in its layout. A Present Day cell is
 * 0.038 × (7 - c) × (12 - i) × (10 - j) Mm³: c = 0 for category A up to 6 for D, i = 0 for Oct,
 * j = 0 for the 10th percentile up to 9 for the 99th. The Natural tables come first and hold 9.999
 * throughout, so reading the wrong section shows at once.
 */
function revisedFile(site) {
	const CATEGORIES = ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D'];
	const percentiles = '          10%       20%       30%       40%       50%       60%       70%       80%       90%       99%';
	const table = (cell) =>
		CATEGORIES.flatMap((cat, c) => [
			`  ${cat} Category`,
			...MONTHS.map((m, i) => `${m}${Array.from({ length: 10 }, (_, j) => pad(cell(c, i, j), 10)).join('')}`),
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
		'TITLE: Synthetic Revised Desktop output',
		'',
		`Revised Desktop Model outputs for site: ${site}`,
		' ',
		...section('Natural', () => 9.999),
		...section('Present Day', (c, i, j) => 0.038 * (7 - c) * (12 - i) * (10 - j)),
		''
	].join('\n');
}

/** Three hydrological years from 2001. Year k = 0 to 2, month i = 0 for Oct: (k + 1) × (i + 1) × 0.01 Mm³. */
function seriesFile(title) {
	const head = `  YEAR${MONTHS.map((m) => m.padStart(9)).join('')}    TOTAL`;
	const rows = [0, 1, 2].map((k) => {
		const values = MONTHS.map((_, i) => round3((k + 1) * (i + 1) * 0.01));
		return `  ${2001 + k} ${values.map((v) => pad(v, 8)).join(' ')}${pad(values.reduce((a, b) => a + b, 0), 9)}`;
	});
	return [title, head, ...rows, ''].join('\n');
}

const ruleFile = (node, ec) => `Synthetic rule curve for ${node}, Ecological Category = ${ec}. Not read by the app.\n`;

const node = (id, over) => ({
	id,
	label: id.split(':')[1],
	basin: id.split(':')[0],
	quat: '',
	river: '',
	comment: '',
	lon: null,
	lat: null,
	approx: false,
	pes: '',
	rec: '',
	tec: '',
	tecInc: '',
	tecCum: '',
	iua: '',
	ewrClass: '',
	ru: '',
	ewrBasis: '',
	ewrNote: '',
	gazPct: null,
	sites: [],
	ecSource: { tec: 'Invented for the tests', pes: 'Invented for the tests', rec: 'Invented for the tests' },
	files: [],
	ecsAvailable: [],
	hasTab: false,
	hasRevised: false,
	...over
});

const file = (name, kind, ec = '', basis = '') => ({ name, kind, ec, basis, variant: false });
const ALL_EC = ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D'];

const NODES = [
	// A .tab node with no TEC, so its REC is the default.
	node('Berg:syb1', {
		quat: 'Z30A', river: 'Sample North', lon: 19, lat: -33.5, pes: 'C', rec: 'C',
		files: [file('SYB1C.tab', 'tab', 'C')], ecsAvailable: ['C'], hasTab: true
	}),
	// No coordinates and no quaternary, so it is listed but not on the map.
	node('Berg:syx1', { river: 'Sample North', ewrNote: 'Invented note: this node has no run.' }),
	// Location approximate: no point of its own, placed inside its quaternary.
	node('Breede:syq1', {
		quat: 'Z20C', river: 'Sample East', lon: 19.8, lat: -34, approx: true, pes: 'B', rec: 'B', tec: 'B',
		files: [file('SYQ1B.tab', 'tab', 'B')], ecsAvailable: ['B'], hasTab: true
	}),
	// Flow series only: no EWR can be drawn until a Revised .rul is added.
	node('Gouritz:syf1', {
		quat: 'Z80A', river: 'Sample South', lon: 22, lat: -33.8, pes: 'C', rec: 'C', tec: 'C',
		files: [file('SYF1.mrv', 'mrv'), file('SYF1.nat', 'hydro')]
	}),
	// A TEC with no file: C and D are as close, and the higher wins.
	node('Gouritz:syn1', {
		quat: 'Z80B', river: 'Sample South', lon: 22.5, lat: -33.4, pes: 'D', rec: 'C', tec: 'C/D',
		files: [file('SYN1B.tab', 'tab', 'B'), file('SYN1C.tab', 'tab', 'C'), file('SYN1D.tab', 'tab', 'D')],
		ecsAvailable: ['B', 'C', 'D'], hasTab: true
	}),
	// Two Revised .rul nodes with no .tab.
	node('Gouritz:syr1', {
		quat: 'Z80C', river: 'Sample South', lon: 21, lat: -33.2, pes: 'B', rec: 'B', tec: 'B',
		files: [file('syr1.rul(NEWFORM)', 'revised')], ecsAvailable: ALL_EC, hasRevised: true
	}),
	node('Gouritz:syr2', {
		quat: 'Z80E', river: 'Sample South', lon: 23, lat: -33.6, pes: 'C', rec: 'B', tec: 'C',
		files: [file('syr2.rul(NEWFORM)', 'revised')], ecsAvailable: ALL_EC, hasRevised: true
	}),
	// The main .tab node, with an EWR site at the same point.
	node('Gouritz:syt1', {
		quat: 'Z80D', river: 'Sample West', lon: 21.5, lat: -33.5, pes: 'D', rec: 'D', tec: 'D', gazPct: 17.6,
		sites: [{ label: 'SYN-SITE1', how: 'Invented for the tests' }],
		files: [
			file('SYT1.nat', 'hydro'), file('SYT1C.tab', 'tab', 'C'), file('SYT1CD.tab', 'tab', 'C/D'), file('SYT1D.mrv', 'mrv', 'D'),
			file('SYT1D.rul', 'rul', 'D'), file('SYT1D.tab', 'tab', 'D')
		],
		ecsAvailable: ['C', 'C/D', 'D'], hasTab: true
	}),
	// Olifants-Doring: Cumulative and Incremental runs, and a gazette that matches the constructed file.
	node('Olifants-Doring:z10b', {
		label: 'Z10B (S44)', quat: 'Z10B', river: 'Sample Central', lon: 19.2, lat: -32.2, pes: 'C', rec: 'C', tec: 'C', tecCum: 'C', tecInc: 'B', gazPct: 43.25,
		files: [
			file('Inc/Z10B_B_Inc_Con.txt', 'con', 'B', 'inc'), file('Inc/Z10B_inc_B_.mrv', 'mrv', 'B', 'inc'), file('Inc/Z10B_inc_B_.tab', 'tab', 'B', 'inc'),
			file('Cum/Z10B_C_cum.mrv', 'mrv', 'C', 'cum'), file('Cum/Z10B_C_cum.tab', 'tab', 'C', 'cum'), file('Cum/Z10B_C_Cum_Con.txt', 'con', 'C', 'cum')
		],
		ecsAvailable: ['B', 'C'], hasTab: true
	})
];

const SITES = [
	{ label: 'SYN-LOOSE', basin: 'Berg', lon: 18.9, lat: -33.3, river: '', node: null, source: 'Invented for the tests' },
	{ label: 'SYN-SITE1', basin: 'Gouritz', lon: 21.5, lat: -33.5, river: 'Sample West', node: 'Gouritz:syt1', source: 'Invented for the tests' }
];

const ISSUES = [
	{ kind: 'code-fix', item: 'syn9', detail: 'Invented correction: read as syn1' },
	{ kind: 'code-fix', item: 'syn8', detail: 'Invented correction: read as syr2' },
	{ kind: 'ec-copy', item: 'SYN1A.tab', detail: 'Invented: identical to the B run, so no A run exists' },
	{ kind: 'file-skipped', item: 'Berg/syb1-note.txt', detail: 'Invented: a note, not a Desktop output' }
];

const STORES = {
	'ewr-berg': { 'SYB1C.tab': desktopFile({ node: 'syb1', ec: 'C', scale: 2 }) },
	'series-berg': {},
	'ewr-breede': { 'SYQ1B.tab': desktopFile({ node: 'syq1', ec: 'B', scale: 2.5 }) },
	'series-breede': {},
	'ewr-gouritz': {
		'SYN1B.tab': desktopFile({ node: 'syn1', ec: 'B', scale: 2.5 }),
		'SYN1C.tab': desktopFile({ node: 'syn1', ec: 'C', scale: 2 }),
		'SYN1D.tab': desktopFile({ node: 'syn1', ec: 'D', scale: 1 }),
		'SYT1C.tab': desktopFile({ node: 'syt1', ec: 'C', scale: 2 }),
		'SYT1CD.tab': desktopFile({ node: 'syt1', ec: 'C/D', scale: 1.5 }),
		'SYT1D.tab': desktopFile({ node: 'syt1', ec: 'D', scale: 1 }),
		'SYT1D.rul': ruleFile('syt1', 'D'),
		'syr1.rul(NEWFORM)': revisedFile('syr1'),
		'syr2.rul(NEWFORM)': revisedFile('syr2')
	},
	'series-gouritz': {
		'SYF1.mrv': seriesFile('Synthetic modified flows for syf1'),
		'SYF1.nat': seriesFile('Synthetic natural flows for syf1'),
		'SYT1.nat': seriesFile('Synthetic natural flows for syt1'),
		'SYT1D.mrv': seriesFile('Synthetic modified flows for syt1, Ecological Category D')
	},
	'ewr-olifantsdoring': {
		'Cum/Z10B_C_cum.tab': desktopFile({ node: 'Z10B', ec: 'C', scale: 2, pct: 21.5 }),
		'Cum/Z10B_C_Cum_Con.txt': desktopFile({ node: 'Z10B', ec: 'C', scale: 2, pct: 43.25, constructed: true }),
		'Inc/Z10B_inc_B_.tab': desktopFile({ node: 'Z10B', ec: 'B', scale: 2.5, pct: 21.5 }),
		'Inc/Z10B_B_Inc_Con.txt': desktopFile({ node: 'Z10B', ec: 'B', scale: 2.5, pct: 43.25, constructed: true })
	},
	'series-olifantsdoring': {
		'Cum/Z10B_C_cum.mrv': seriesFile('Synthetic modified flows for Z10B, Cumulative'),
		'Inc/Z10B_inc_B_.mrv': seriesFile('Synthetic modified flows for Z10B, Incremental')
	}
};

const json = (value) => `${JSON.stringify(value, null, '\t')}\n`;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}index.json`, json({
	// `pnpm data:sample` and the Playwright config read this to tell the sample from real data.
	sample: true,
	nodes: NODES,
	sites: SITES,
	issues: ISSUES,
	meta: {
		files: Object.values(STORES).reduce((n, store) => n + Object.keys(store).length, 0),
		sources: {
			quaternaries: 'Quaternary catchments and basins: DWS service, loaded live (Weepener et al. 2012, updated 2018)',
			rivers: 'DWS 1:500 000 rivers (2012 release), Cape datum shifted to WGS84',
			nodes: 'Synthetic sample nodes, invented for the tests',
			ec: 'Synthetic sample categories, invented for the tests'
		}
	}
}));
for (const slug of Object.values(BASINS)) {
	for (const group of ['ewr', 'series']) writeFileSync(`${OUT}${group}-${slug}.json`, json(STORES[`${group}-${slug}`]));
}
