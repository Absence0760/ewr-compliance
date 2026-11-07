// The one app state. Components read it and call its methods; none fetch data themselves.
import { asset } from '$app/paths';
import { ewrLines, gaugeFlow, gaugeSeries, parseGaugeFlows, parseMon, parseRevised, parseTab, ymKey } from '#lib/ewr/parsers.ts';
import { dwsEntry, dwsOffer, dwsPath, dwsUnavailable, parseDwsIndex, type DwsMonthlyFile, type DwsState, type DwsWant } from '#lib/ewr/dwsStore.ts';
import { allFiles, buildNotices, resolveView } from '#lib/ewr/resolve.ts';
import type {
	EcBasis, EwrNode, EwrSite, Flow, FlowSource, FlowUnit, GaugeData, GaugeFlowFile, GaugeFlows, GaugeLink, GaugeRecord, HistView, IndexData, Issue, NodeChoices, NodeFile, NodeInfo, NodeInfoData, NodeView, Notice, ResolvedLines, RtView, Sheet, YearIs
} from '#lib/ewr/types.ts';
import { readStored, STORAGE, writeStored } from './storage.ts';

const slug = (b: string) => b.toLowerCase().replace(/-/g, '');

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
	links = $state.raw<GaugeLink[]>([]);
	/** What the RQO node workbook records at each node, by id. */
	nodeInfo = $state.raw<NodeInfoData>({});
	gaugeRecords = new Map<string, GaugeRecord>();
	flowStations = new Set<string>();
	/** Gauges' daily and 12-minute flow, by station, as each is first opened. */
	flows = $state.raw<Record<string, GaugeFlows>>({});
	flowsError = $state('');

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
	/** A node starts on its linked gauge where the gauge has data, and otherwise on a spreadsheet. */
	histView = $state<HistView>({ source: 'sheet', preset: 'full', from: 0, to: 0, overlay: true });
	rtView = $state<RtView>({ source: 'sheet', month: 'all', showRaw: false });

	/** Our own store of DWS flow, under dws/: its index, read once at start. */
	dws = $state.raw<DwsState>({ status: 'loading' });
	/** The store's daily flow and readings, and its monthly volumes, by station, as each is first used. */
	dwsFlows = $state.raw<Record<string, GaugeFlows>>({});
	dwsMonthly = $state.raw<Record<string, GaugeRecord>>({});
	dwsError = $state('');

	lines = $state.raw<ResolvedLines | null>(null);
	notices = $state.raw<Notice[]>([]);

	/** The gauge whose record fills the panel, or null when the panel shows the node. */
	gaugeView = $state<{ station: string; name: string } | null>(null);

	/** File shown in the viewer dialog, or null when closed. */
	viewer = $state<{ nodeId: string; file: string } | null>(null);

	private stores: Record<string, Promise<Record<string, string>>> = {};
	private seq = 0;

	selected = $derived(this.selectedId ? (this.byId.get(this.selectedId) ?? null) : null);
	view = $derived(this.selected ? this.viewOf(this.selected) : null);
	link = $derived(this.selected ? this.linkOf(this.selected.id) : null);
	/** The factor in use: the node's own if one was typed, otherwise its link's. */
	factor = $derived(this.link ? (this.choices[this.link.node]?.factor ?? this.link.factor) : 1);
	/** The selected node's gauge record, factored to the node. */
	gaugeFlow = $derived.by(() => {
		const record = this.link && this.gaugeRecords.get(this.link.station);
		return record ? gaugeFlow(record, this.factor) : null;
	});
	/** The selected node's gauge flow for the Real Time Comparison, factored to the node. */
	gaugeRt = $derived.by(() => {
		const flows = this.link && this.flows[this.link.station];
		return flows ? gaugeSeries(flows, this.factor) : null;
	});
	/** The store's monthly volumes for the selected node's gauge, factored to the node like the gauge's own. */
	dwsHist = $derived.by(() => {
		const record = this.link && this.dwsMonthly[this.link.station];
		return record ? gaugeFlow(record, this.factor) : null;
	});
	/** The store's daily flow and readings for the selected node's gauge, factored to the node like the gauge's own. */
	dwsRt = $derived.by(() => {
		const flows = this.link && this.dwsFlows[this.link.station];
		return flows ? gaugeSeries(flows, this.factor) : null;
	});
	/** The store's entry for the selected node's gauge, once the index is read. */
	dwsStation = $derived(dwsEntry(this.dws, this.link));
	/** The observed record the Historical Comparison is using. */
	histFlow = $derived(
		this.histView.source === 'gauge' ? this.gaugeFlow : this.histView.source === 'dws' ? this.dwsHist : this.hist.flow
	);

	viewOf(n: EwrNode): NodeView {
		return resolveView(n, this.ecBasis, this.choices[n.id], !!this.uploads[n.id]);
	}

	filesOf(n: EwrNode): NodeFile[] {
		return allFiles(n, this.uploads[n.id]);
	}

	infoOf(nodeId: string): NodeInfo {
		return this.nodeInfo[nodeId] ?? {};
	}

	linkOf(nodeId: string): GaugeLink | null {
		return this.links.find((l) => l.node === nodeId) ?? null;
	}

	async load(): Promise<void> {
		this.restore();
		try {
			const [res, gaugeRes, infoRes] = await Promise.all([
				fetch(asset('data/index.json')), fetch(asset('data/gauges.json')), fetch(asset('data/node-info.json'))
			]);
			if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
			if (!gaugeRes.ok) throw new Error(`gauges.json: HTTP ${gaugeRes.status}`);
			if (!infoRes.ok) throw new Error(`node-info.json: HTTP ${infoRes.status}`);
			const [d, g, info] = (await Promise.all([res.json(), gaugeRes.json(), infoRes.json()])) as [IndexData, GaugeData, NodeInfoData];
			this.nodeInfo = info;
			this.gaugeRecords = new Map(Object.entries(g.records).map(([station, text]) => [station, parseMon(text, g.incomplete[station])]));
			this.links = g.links;
			this.flowStations = new Set(g.flows);
			this.byId = new Map(d.nodes.map((n) => [n.id, n]));
			this.nodes = d.nodes;
			this.sites = d.sites;
			this.issues = d.issues;
			this.meta = d.meta;
			this.loaded = true;
		} catch (e) {
			this.loadError = (e as Error).message;
		}
		void this.loadDws();
	}

	/**
	 * The store's index. The app works without it: a copy of the site with no store, such as `pnpm dev`, gets a
	 * 404, and the DWS source then says the store is not there. Revalidated, as the store changes every day.
	 */
	private async loadDws(): Promise<void> {
		try {
			const res = await fetch(asset(dwsPath.index as never), { cache: 'no-cache' });
			this.dws = res.ok ? { status: 'ready', index: parseDwsIndex(await res.json()) } : dwsUnavailable(res.status);
		} catch (e) {
			this.dws = dwsUnavailable(null, (e as Error).message);
		}
		if (this.selected) {
			this.syncHistSource();
			this.syncRtSource();
		}
	}

	/** Whether the DWS source can be picked for the selected node: while the index is read, it may be. */
	dwsOk(want: DwsWant): boolean {
		return dwsOffer(this.dws, this.link, want).ok;
	}

	private restore() {
		try {
			const raw = localStorage.getItem(STORAGE);
			const { stored, migrated } = readStored(raw);
			if (stored.ecBasis) this.ecBasis = stored.ecBasis;
			if (stored.choices) this.choices = stored.choices;
			// Drop what an older version kept, such as the DWS API addresses, rather than carry it on.
			if (migrated) localStorage.setItem(STORAGE, writeStored(stored));
		} catch {
			/* storage unavailable: the app works without it */
		}
	}

	private persist() {
		try {
			localStorage.setItem(STORAGE, writeStored({ ecBasis: this.ecBasis, choices: this.choices }));
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
		this.gaugeView = null;
		this.syncHistSource();
		this.syncRtSource();
		if (opts.focus) this.focus = { id, n: (this.focus?.n ?? 0) + 1 };
		void this.refresh();
	}

	/**
	 * A linked gauge is the node's record unless a loaded file or the DWS store is in use. A node whose gauge
	 * has no record, or that has no link, cannot stay on it, and goes to the store if it can, or a spreadsheet.
	 * The store can be kept only for a node whose gauge it holds.
	 */
	private syncHistSource() {
		const h = this.histView;
		const dws = this.dwsOk('monthly');
		if (h.source === 'gauge' && !this.gaugeFlow) h.source = dws ? 'dws' : 'sheet';
		else if (h.source === 'dws' && !dws) h.source = this.gaugeFlow ? 'gauge' : 'sheet';
		else if (this.gaugeFlow && h.source !== 'dws' && !this.hist.flow) h.source = 'gauge';
		if (h.source === 'gauge') this.wholeRecord(this.gaugeFlow);
		if (h.source === 'dws') void this.loadDwsMonthly();
	}

	private syncRtSource() {
		const r = this.rtView;
		const station = this.link && this.flowStations.has(this.link.station) ? this.link.station : null;
		const dws = this.dwsOk('instant');
		if (r.source === 'gauge' && !station) this.setRtSource(dws ? 'dws' : 'sheet');
		else if (r.source === 'dws' && !dws) this.setRtSource(station ? 'gauge' : 'sheet');
		else if (station && r.source !== 'gauge' && r.source !== 'dws' && !this.rt.flow) r.source = 'gauge';
		if (station) void this.loadFlows(station);
		if (r.source === 'dws') void this.loadDwsFlows();
	}

	setRtSource(source: FlowSource) {
		this.rtView.source = source;
		this.rtView.month = 'all';
		if (source === 'dws') void this.loadDwsFlows();
	}

	/** Fetch one file of the store, revalidated, or throw with its HTTP status. */
	private async dwsFile<T>(path: string): Promise<T> {
		const res = await fetch(asset(path as never), { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as T;
	}

	/** The store's daily flow and readings for the selected node's gauge, read once. A failure is said, and tried again next time. */
	async loadDwsFlows(): Promise<void> {
		const station = this.link?.station;
		// Not before the index says the store holds it: a store that is not there should cost one request, not one a station.
		if (!station || this.dwsFlows[station] || !this.dwsStation) return;
		this.dwsError = '';
		try {
			const file = await this.dwsFile<GaugeFlowFile>(dwsPath.flows(station));
			this.dwsFlows = { ...this.dwsFlows, [station]: parseGaugeFlows(file) };
		} catch (e) {
			this.dwsError = `The DWS store's flow for ${station} could not be loaded: ${(e as Error).message}`;
		}
	}

	/** The store's monthly volumes for the selected node's gauge, read once, and shown from the whole record. */
	async loadDwsMonthly(): Promise<void> {
		const station = this.link?.station;
		if (!station || this.dwsMonthly[station] || !this.dwsStation?.monthly) return;
		this.dwsError = '';
		try {
			const file = await this.dwsFile<DwsMonthlyFile>(dwsPath.monthly(station));
			this.dwsMonthly = { ...this.dwsMonthly, [station]: parseMon(file.monthly, file.incomplete) };
			if (this.histView.source === 'dws' && this.link?.station === station) this.wholeRecord(this.histFlow);
		} catch (e) {
			this.dwsError = `The DWS store's monthly volumes for ${station} could not be loaded: ${(e as Error).message}`;
		}
	}

	/** Read once. A failed read is said in the panel, and is tried again next time. */
	async loadFlows(station: string): Promise<void> {
		if (this.flows[station]) return;
		this.flowsError = '';
		try {
			const res = await fetch(asset(`data/flows-${station}.json` as never));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.flows = { ...this.flows, [station]: parseGaugeFlows((await res.json()) as GaugeFlowFile) };
		} catch (e) {
			this.flowsError = `Flow for ${station} could not be loaded: ${(e as Error).message}`;
		}
	}

	setHistSource(source: FlowSource) {
		this.histView.source = source;
		this.wholeRecord(this.histFlow);
		if (source === 'dws') void this.loadDwsMonthly();
	}

	/** Open a gauge's record in the panel. A gauge with no record leaves the panel on the node. */
	showGauge(station: string, name = '') {
		const has = this.flowStations.has(station);
		this.gaugeView = has || this.gaugeRecords.has(station) ? { station, name } : null;
		if (has) void this.loadFlows(station);
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
		this.wholeRecord(slot.flow);
	}

	private wholeRecord(f: Flow | null) {
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

	openFile(nodeId: string, file: string) {
		this.viewer = { nodeId, file };
	}
}

export const app = new AppState();
