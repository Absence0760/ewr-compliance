// The one app state. Components read it and call its methods; none fetch data themselves.
import { asset } from '$app/paths';
import { ewrLines, parseRevised, parseTab, ymKey } from '#lib/ewr/parsers.ts';
import { allFiles, buildNotices, resolveView } from '#lib/ewr/resolve.ts';
import type {
	EcBasis, EwrNode, EwrSite, Flow, FlowUnit, FlowWant, HistView, IndexData, Issue, NodeChoices, NodeFile, NodeView, Notice, ResolvedLines, RtView, Sheet, YearIs
} from '#lib/ewr/types.ts';

const slug = (b: string) => b.toLowerCase().replace(/-/g, '');
const STORAGE = 'ewr';

export interface FlowSlot {
	sheets: Sheet[];
	sheet: Sheet | null;
	name: string;
	unitIn: FlowUnit;
	yearIs: YearIs;
	flow: Flow | null;
	message: { level: 'info' | 'error'; text: string } | null;
}

const emptySlot = (unitIn: FlowUnit): FlowSlot => ({
	sheets: [], sheet: null, name: '', unitIn, yearIs: 'start', flow: null, message: null
});

class AppState {
	loaded = $state(false);
	loadError = $state('');
	nodes = $state.raw<EwrNode[]>([]);
	sites = $state.raw<EwrSite[]>([]);
	issues = $state.raw<Issue[]>([]);
	meta = $state.raw<IndexData['meta'] | null>(null);
	byId = new Map<string, EwrNode>();

	ecBasis = $state<EcBasis>('TEC');
	choices = $state<Record<string, NodeChoices>>({});
	uploads = $state.raw<Record<string, { name: string; text: string }>>({});
	selectedId = $state<string | null>(null);
	/** Node the map should fly to and open the popup for; bumps on each request. */
	focus = $state<{ id: string; n: number } | null>(null);

	unit = $state<FlowUnit>('cumec');
	tab = $state<'hist' | 'rt'>('hist');
	hist = $state.raw<FlowSlot>(emptySlot('mm3'));
	rt = $state.raw<FlowSlot>(emptySlot('cumec'));
	histView = $state<HistView>({ source: 'sheet', preset: 'full', from: 0, to: 0, overlay: true });
	rtView = $state<RtView>({ source: 'sheet', month: 'all', showRaw: false });
	rtApi = $state({ url: '', station: '' });
	histApi = $state({ url: '', station: '' });

	lines = $state.raw<ResolvedLines | null>(null);
	notices = $state.raw<Notice[]>([]);

	/** File shown in the viewer dialog, or null when closed. */
	viewer = $state<{ nodeId: string; file: string } | null>(null);

	private stores: Record<string, Promise<Record<string, string>>> = {};
	private seq = 0;

	selected = $derived(this.selectedId ? (this.byId.get(this.selectedId) ?? null) : null);
	view = $derived(this.selected ? this.viewOf(this.selected) : null);

	viewOf(n: EwrNode): NodeView {
		return resolveView(n, this.ecBasis, this.choices[n.id], !!this.uploads[n.id]);
	}

	filesOf(n: EwrNode): NodeFile[] {
		return allFiles(n, this.uploads[n.id]);
	}

	async load(): Promise<void> {
		this.restore();
		try {
			const res = await fetch(asset('data/index.json'));
			if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
			const d = (await res.json()) as IndexData;
			this.byId = new Map(d.nodes.map((n) => [n.id, n]));
			this.nodes = d.nodes;
			this.sites = d.sites;
			this.issues = d.issues;
			this.meta = d.meta;
			this.loaded = true;
		} catch (e) {
			this.loadError = (e as Error).message;
		}
	}

	private restore() {
		try {
			const s = JSON.parse(localStorage.getItem(STORAGE) || '{}');
			if (s.ecBasis) this.ecBasis = s.ecBasis;
			if (s.choices) this.choices = s.choices;
			if (s.rtApi) this.rtApi = s.rtApi;
			if (s.histApi) this.histApi = s.histApi;
		} catch {
			/* storage unavailable: the app works without it */
		}
	}

	private persist() {
		try {
			localStorage.setItem(STORAGE, JSON.stringify({ ecBasis: this.ecBasis, choices: this.choices, rtApi: this.rtApi, histApi: this.histApi }));
		} catch {
			/* storage unavailable */
		}
	}

	private store(basin: string, group: 'ewr' | 'series'): Promise<Record<string, string>> {
		const key = `${group}-${slug(basin)}`;
		return (this.stores[key] ??= fetch(asset(`data/${key}.json` as never))
			.then((r) => {
				if (!r.ok) throw new Error(`${key}.json: HTTP ${r.status}`);
				return r.json();
			})
			.catch((e) => {
				// Not cached, so the next attempt can recover.
				delete this.stores[key];
				throw e;
			}));
	}

	async fileText(n: EwrNode, f: NodeFile): Promise<string> {
		if (f.uploaded) return this.uploads[n.id].text;
		const heavy = f.kind === 'mrv' || f.kind === 'hydro';
		return (await this.store(n.basin, heavy ? 'series' : 'ewr'))[f.name];
	}

	/** Recompute lines and notices for the selected node. */
	async refresh(): Promise<void> {
		const n = this.selected;
		const seq = ++this.seq;
		if (!n) {
			this.lines = null;
			this.notices = [];
			return;
		}
		const v = this.viewOf(n);
		const c = this.choices[n.id] ?? {};
		try {
			let lines: ResolvedLines | null = null;
			if (v.ec && v.method === 'revised') {
				const f = this.filesOf(n).find((x) => x.kind === 'revised')!;
				const revised = parseRevised(await this.fileText(n, f));
				lines = { ...ewrLines({ revised, ec: v.ec, percentile: c.pct ?? 50, droughtPercentile: c.dpct ?? 90 }), file: f.name };
			} else if (v.ec && v.source) {
				const tab = parseTab(await this.fileText(n, v.source));
				lines = { ...ewrLines({ tab }), file: v.source.name, tab };
			}
			const texts = lines?.tab ? await this.store(n.basin, 'ewr') : null;
			if (seq !== this.seq) return;
			this.lines = lines;
			this.notices = buildNotices(n, v, this.ecBasis, c, lines, texts);
		} catch (e) {
			if (seq !== this.seq) return;
			this.lines = null;
			this.notices = [{ level: 'error', text: (e as Error).message }];
		}
	}

	select(id: string, opts: { focus?: boolean } = {}) {
		this.selectedId = id;
		if (opts.focus) this.focus = { id, n: (this.focus?.n ?? 0) + 1 };
		void this.refresh();
	}

	setEcBasis(b: EcBasis) {
		this.ecBasis = b;
		// A global change restarts from the chosen category on every node.
		for (const c of Object.values(this.choices)) delete c.ec;
		this.persist();
		void this.refresh();
	}

	choose(id: string, patch: NodeChoices) {
		this.choices[id] = { ...this.choices[id], ...patch };
		this.persist();
		if (id === this.selectedId) void this.refresh();
	}

	/** Throws if the file is not a Revised Desktop output. */
	addRevised(id: string, name: string, text: string) {
		parseRevised(text);
		this.uploads = { ...this.uploads, [id]: { name, text } };
		this.choose(id, { method: 'revised' });
	}

	/** Newly built flow restarts from the whole record, as a new file should. */
	setHist(slot: FlowSlot) {
		this.hist = slot;
		const f = slot.flow;
		if (f?.first && f.last) {
			this.histView.preset = 'full';
			this.histView.from = ymKey(f.first.y, f.first.m);
			this.histView.to = ymKey(f.last.y, f.last.m);
		}
	}

	setRt(slot: FlowSlot) {
		this.rt = slot;
		if (slot.flow) this.rtView.month = 'all';
	}

	setApi(want: FlowWant, url: string, station: string) {
		if (want === 'instant') this.rtApi = { url, station };
		else this.histApi = { url, station };
		this.persist();
	}

	openFile(nodeId: string, file: string) {
		this.viewer = { nodeId, file };
	}
}

export const app = new AppState();
