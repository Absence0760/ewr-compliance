// Shapes shared by the parsers, the app state and the components.

export type Cell = string | number | Date | null | undefined;
export type FlowUnit = 'mm3' | 'cumec';
export type YearIs = 'start' | 'end';
export type FlowStep = 'monthly' | 'daily' | 'instantaneous';
export type EcBasis = 'TEC' | 'REC' | 'PES';
export type Method = 'tab' | 'revised';
export type FlowBasis = '' | 'cum' | 'inc';
export type FileKind = 'tab' | 'con' | 'rul' | 'revised' | 'mrv' | 'hydro';
export type StatusKey = 'good' | 'warning' | 'serious' | 'critical' | 'none';

export interface NodeFile {
	name: string;
	kind: FileKind;
	ec: string;
	basis: string;
	variant?: boolean;
	uploaded?: boolean;
}

export interface EwrNode {
	id: string;
	label: string;
	basin: string;
	quat: string;
	river: string;
	comment: string;
	lon: number | null;
	lat: number | null;
	approx: boolean;
	pes: string;
	rec: string;
	tec: string;
	tecInc: string;
	tecCum: string;
	iua: string;
	ewrClass: string;
	ru: string;
	ewrBasis: string;
	/** Why no EWR can be drawn, from the sources. Empty when one can, or when they do not say. */
	ewrNote?: string;
	gazPct: number | null;
	sites: { label: string; how: string }[];
	ecSource: Record<string, string>;
	files: NodeFile[];
	ecsAvailable: string[];
	hasTab: boolean;
	hasRevised: boolean;
}

export interface EwrSite {
	label: string;
	basin: string;
	lon: number;
	lat: number;
	river: string;
	node: string | null;
	source: string;
}

export interface Issue {
	kind: string;
	item: string;
	detail: string;
}

export interface IndexData {
	nodes: EwrNode[];
	sites: EwrSite[];
	issues: Issue[];
	meta: { files: number; sources: Record<string, string> };
	/** Set only on the synthetic dataset in e2e/fixtures/sample-data. */
	sample?: boolean;
}

/** One month of a gauge record, as published. A flagged month keeps its figure, to be shown. */
export interface GaugeMonth {
	v: number | null;
	quality: string;
	/** The # flag: incomplete or missing, so left out of every mean. */
	incomplete: boolean;
}

export interface GaugeYear {
	label: string;
	start: number;
	months: GaugeMonth[];
	total: GaugeMonth;
}

/** Monthly volumes of one gauge in Mm³, hydrological years, Oct first. */
export interface GaugeRecord {
	station: string;
	years: GaugeYear[];
}

/** A gauge's flow in m³/s: its daily record, then its 12-minute readings. */
export interface GaugeFlows {
	daily: FlowPoint[];
	readings: FlowPoint[];
}

/** A gauge's flow ready to plot. A day in the daily record is not taken from the readings as well. */
export interface GaugeSeries {
	days: DayMean[];
	readings: FlowPoint[];
	/** Days the daily record lists with no flow. */
	missing: number;
}

/** The gauge that measures a node's flow. factor scales the record to the node, and is worked out outside the app. */
export interface GaugeLink {
	node: string;
	station: string;
	factor: number;
	note: string;
}

/**
 * static/data/gauges.json: the links, each gauge's monthly file text by station, the stations with a
 * static/data/flows-<station>.json, which is loaded when one is opened, and the months to leave out.
 */
export interface GaugeData {
	links: GaugeLink[];
	records: Record<string, string>;
	flows: string[];
	/** Months by station, YYYY-MM, that the gauge's daily record shows as incomplete. */
	incomplete: Record<string, string[]>;
}

/**
 * What the RQO node workbook records at a node, beyond its EWR: the REMP/BM site, the EWR site ID of the
 * Reserve Gazette, the water quality monitoring station, and the Strategic Water Source Areas, surface
 * water and groundwater, the node is in. Each is the workbook's text. A field it records nothing for is absent.
 */
export interface NodeInfo {
	remp?: string;
	ewrSite?: string;
	wqStation?: string;
	swsaSw?: string;
	swsaGw?: string;
}

/** static/data/node-info.json: NodeInfo by node id. A node the workbook records nothing for is absent. */
export type NodeInfoData = Record<string, NodeInfo>;

/** static/data/flows-<station>.json:the text of a DWS daily file and of the 12-minute readings. */
export interface GaugeFlowFile {
	daily: string;
	readings: string;
}

export interface ParsedTab {
	ec: string;
	natural: (number | null)[];
	low: (number | null)[];
	drought: (number | null)[];
	total: (number | null)[];
	mar: number | null;
	totalIfr: number | null;
	totalPct: number | null;
	distribution: string;
}

export interface ParsedRevised {
	site: string;
	tables: Record<string, number[][]>;
}

export interface LineInput {
	tab?: ParsedTab | null;
	revised?: ParsedRevised | null;
	ec?: string;
	percentile?: number;
	droughtPercentile?: number;
}

/** Monthly lines in Mm3, Oct first. urgent is 10% below ewr, for both methods. */
export interface EwrLines {
	ewr: number[];
	drought: number[];
	urgent: number[];
}

export interface ResolvedLines extends EwrLines {
	file: string;
	tab?: ParsedTab;
}

export interface Layout {
	kind: 'matrix' | 'series';
	headerRow: number;
	unit: FlowUnit | '';
	title: string;
	unitHint?: FlowUnit | '';
	yearCol?: number;
	monthCol?: number;
	dateCol?: number;
	timeCol?: number;
	valueCol?: number;
	cols?: { m: number; c: number }[];
	firstMonth?: number;
	/** The quality code column of dated rows, or -1. */
	qualCol?: number;
}

export interface MonthRecord {
	y: number;
	m: number;
	v: number | null;
}

export interface FlowPoint {
	t: number;
	v: number | null;
	/** Quality code, where the source gives one. */
	code?: string;
}

export interface Flow {
	records: MonthRecord[];
	points: FlowPoint[] | null;
	step: FlowStep;
	unit: FlowUnit;
	first: MonthRecord | null;
	last: MonthRecord | null;
	months: number;
	missing: number;
}

export interface MonthMean {
	n: number;
	mean: number | null;
	values: number[];
}

export interface MonthState {
	key: StatusKey;
	label: string;
}

export interface DayMean {
	t: number;
	mean: number;
	n: number;
	/** The day's quality code, a coded one first, where the source gives one. */
	code?: string;
}

export interface Sheet {
	name: string;
	rows: Cell[][];
	widths: number[][] | null;
	layout: Layout | null;
}

/** What a node shows right now: the outcome of its data and the user's choices. */
export interface NodeView {
	basis: FlowBasis;
	cand: NodeFile[];
	avail: string[];
	target: { ec: string; source: string };
	ec: string;
	sources: NodeFile[];
	method: Method;
	source: NodeFile | null;
	hasRevised: boolean;
}

export interface NodeChoices {
	ec?: string;
	method?: Method;
	source?: string;
	basis?: FlowBasis;
	pct?: number;
	dpct?: number;
	factor?: number;
}

export interface Notice {
	level: 'warn' | 'info' | 'error';
	text: string;
}

/** Where observed flow comes from. */
export type FlowSource = 'sheet' | 'text' | 'api' | 'gauge';
export type FlowWant = 'monthly' | 'instant';
export type PeriodPreset = 'full' | '10' | '20' | 'custom';

/** The Historical Comparison's choices. from and to are ymKey values. */
export interface HistView {
	source: FlowSource;
	preset: PeriodPreset;
	from: number;
	to: number;
	overlay: boolean;
}

/** The Real Time Comparison's choices. month is 'all' or YYYY-MM. */
export interface RtView {
	source: FlowSource;
	month: string;
	showRaw: boolean;
}
