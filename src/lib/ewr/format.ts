export const CALENDAR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmt = (v: number | null | undefined, d = 3): string =>
	v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d);

/** Series colours. Validated for colour-blind separation; flow is drawn with markers, urgent dashed. */
export const SERIES = {
	flow: '#2a78d6',
	ewr: '#eb6834',
	urgent: '#6250d6',
	drought: '#1baf7a',
	full: '#52514e',
	raw: '#a9c8ee'
} as const;

export const KIND_LABEL: Record<string, string> = {
	tab: '.tab', con: 'Constructed _Con.txt', rul: '.rul', revised: 'Revised .rul', mrv: '.mrv', hydro: 'Hydrology'
};
