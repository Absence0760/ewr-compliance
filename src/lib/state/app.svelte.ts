// The one app state. Components read it and call its methods; none fetch data themselves.
import { asset } from '$app/paths';
import { ewrLines, gaugeDays, gaugeFlow, gaugeReadings, parseGaugeFlows, parseMon, parseRevised, parseTab, ymKey } from '#lib/ewr/parsers.ts';
import { dwsEntry, dwsOffer, dwsPath, dwsUnavailable, parseDwsIndex, type DwsMonthlyFile, type DwsState, type DwsWant } from '#lib/ewr/dwsStore.ts';
import { allFiles, buildNotices, resolveView } from '#lib/ewr/resolve.ts';
import type {
	DayView, EcBasis, EwrNode, EwrSite, Flow, FlowSource, FlowUnit, GaugeData, GaugeFlowFile, GaugeFlows, GaugeLink, GaugeRecord, HistStep, HistView, IndexData, Issue, NodeChoices, NodeFile, NodeInfo, NodeInfoData, NodeView, Notice, ResolvedLines, RtView, Sheet, YearIs
} from '#lib/ewr/types.ts';
import { readStored, STORAGE, writeStored } from './storage.ts';
import { siteFetch } from '#lib/users/siteFetch.ts';
import { deleteNode, restoreNode, saveNode } from '#lib/users/api.ts';
import { nodeKey, nodeStorePath, parseNodeStoreIndex, parseWmaOverlay, type NodeTexts, type WmaOverlay } from '#lib/ewr/nodeStore.ts';
import { mergeOverlays, readNodeTexts, type ReadTexts } from '#lib/ewr/nodeOverlay.ts';
import { WMAS, wmaBySlug, wmaOfBasin } from '#lib/components/map/wma.ts';

const WMA_SLUGS = WMAS.map((w) => w.slug);

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
	byId = $state.raw(new Map<string, EwrNode>());
	/** The node store's file for each WMA that has one, as last read (docs/architecture.md § Node store). */
	overlays = $state.raw<Record<string, WmaOverlay>>({});
	/** The WMA of each node added on the site, by id: its overlay's, whatever its basin. */
	uploadedWma = $state.raw(new Map<string, string>());
	/** Built-in nodes an admin deleted, hidden until restored. */
	hidden = $state.raw<{ wma: string; node: EwrNode }[]>([]);
	/** Said once when the node store could not be read, in whole or for a WMA. Empty with no store (a 404). */
	nodeStoreNote = $state('');
	/** The node an admin asked to delete, whose confirmation is open, or null. */
	deleting = $state<string | null>(null);
	/** What the last change an admin made to the store did, for the map's admin tools to say. */
	nodeStoreDone = $state('');
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
	/** The Historical Comparison's view: mean monthly volumes over a period, or the daily record a month at a time. */
	histStep = $state<HistStep>('monthly');
	hist = $state.raw<FlowSlot>(emptySlot('mm3'));
	day = $state.raw<FlowSlot>(emptySlot('cumec'));
	rt = $state.raw<FlowSlot>(emptySlot('cumec'));
	/** A node starts on its linked gauge where the gauge has data, and otherwise on a spreadsheet. */
	histView = $state<HistView>({ source: 'sheet', preset: 'full', from: 0, to: 0, overlay: true });
	dayView = $state<DayView>({ source: 'sheet', month: 'all' });
	/** The Real Time Comparison is the 12-minute readings, so they are drawn from the start. */
	rtView = $state<RtView>({ source: 'sheet', month: 'all', showRaw: true });

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
	/** The built-in nodes, from data/index.json, that the node store is merged over. */
	private builtIn: EwrNode[] = [];
	/** Each uploaded node's texts, read when it is first opened, until its WMA's file is read again. */
	private uploadedTexts: Record<string, Promise<ReadTexts>> = {};
	private nodeStoreSeq = 0;
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
	/** The selected node's gauge daily record, for the Historical Comparison's daily flow, factored to the node. */
	gaugeDay = $derived.by(() => {
		const flows = this.link && this.flows[this.link.station];
		return flows ? gaugeDays(flows, this.factor) : null;
	});
	/** The selected node's gauge 12-minute readings for the Real Time Comparison, factored to the node. */
	gaugeRt = $derived.by(() => {
		const flows = this.link && this.flows[this.link.station];
		return flows ? gaugeReadings(flows, this.factor) : null;
	});
	/** The store's monthly volumes for the selected node's gauge, factored to the node like the gauge's own. */
	dwsHist = $derived.by(() => {
		const record = this.link && this.dwsMonthly[this.link.station];
		return record ? gaugeFlow(record, this.factor) : null;
	});
	/** The store's daily flow for the selected node's gauge, factored to the node like the gauge's own. */
	dwsDay = $derived.by(() => {
		const flows = this.link && this.dwsFlows[this.link.station];
		return flows ? gaugeDays(flows, this.factor) : null;
	});
	/** The store's 12-minute readings for the selected node's gauge, factored to the node like the gauge's own. */
	dwsRt = $derived.by(() => {
		const flows = this.link && this.dwsFlows[this.link.station];
		return flows ? gaugeReadings(flows, this.factor) : null;
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

	/** The WMA a node is in: its overlay's for a node added on the site, otherwise its basin's. */
	wmaOf(n: EwrNode): string | undefined {
		return this.uploadedWma.get(n.id) ?? wmaOfBasin(n.basin)?.slug;
	}

	/** Whether the node was added on the site, rather than built in. */
	isUploaded(id: string): boolean {
		return this.uploadedWma.has(id);
	}

	linkOf(nodeId: string): GaugeLink | null {
		return this.links.find((l) => l.node === nodeId) ?? null;
	}

	async load(): Promise<void> {
		this.restore();
		try {
			const [res, gaugeRes, infoRes] = await Promise.all([
				siteFetch(asset('data/index.json')), siteFetch(asset('data/gauges.json')), siteFetch(asset('data/node-info.json'))
			]);
			if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
			if (!gaugeRes.ok) throw new Error(`gauges.json: HTTP ${gaugeRes.status}`);
			if (!infoRes.ok) throw new Error(`node-info.json: HTTP ${infoRes.status}`);
			const [d, g, info] = (await Promise.all([res.json(), gaugeRes.json(), infoRes.json()])) as [IndexData, GaugeData, NodeInfoData];
			this.nodeInfo = info;
			this.gaugeRecords = new Map(Object.entries(g.records).map(([station, text]) => [station, parseMon(text, g.incomplete[station])]));
			this.links = g.links;
			this.flowStations = new Set(g.flows);
			this.builtIn = d.nodes;
			this.applyOverlays();
			this.sites = d.sites;
			this.issues = d.issues;
			this.meta = d.meta;
			this.loaded = true;
		} catch (e) {
			this.loadError = (e as Error).message;
		}
		void this.loadDws();
		if (this.loaded) void this.loadNodeStore();
	}

	/** The built-in nodes with the node store's overlays merged over them. A node that went away is no longer selected. */
	private applyOverlays() {
		const overlays = WMA_SLUGS.flatMap((w) => (this.overlays[w] ? [this.overlays[w]] : []));
		const m = mergeOverlays(this.builtIn, overlays, (n) => wmaOfBasin(n.basin)?.slug);
		const before = this.selected;
		this.byId = new Map(m.nodes.map((n) => [n.id, n]));
		this.nodes = m.nodes;
		this.uploadedWma = m.uploaded;
		this.hidden = m.hidden;
		if (before && !this.byId.has(before.id)) {
			this.selectedId = null;
			if (this.viewer?.nodeId === before.id) this.viewer = null;
			void this.refresh();
		} else if (before && this.byId.get(before.id) !== before) {
			void this.refresh();
		}
	}

	/**
	 * The node store, read as the DWS store's index is: at start, revalidated, and the app works without it.
	 * A 404 (no store, as on `pnpm dev`, the e2e servers, or a site before it has one) is no overlays, said
	 * nowhere. Any other failure keeps the built-in nodes and says so once. Each WMA's file listed is read and
	 * checked whole; one that fails is left out, and said, never half-read. Read again after an admin's change:
	 * a WMA whose file is unchanged (its `updatedAt`) is kept, unless it is `changed`, the one just written.
	 */
	async loadNodeStore(changed?: string): Promise<void> {
		const seq = ++this.nodeStoreSeq;
		const current = () => seq === this.nodeStoreSeq;
		let wmas: Record<string, { updatedAt: string }>;
		try {
			const res = await siteFetch(asset(nodeStorePath.index as never), { cache: 'no-cache' });
			if (res.status === 404) {
				if (!current()) return;
				this.overlays = {};
				this.nodeStoreNote = '';
				this.forgetTexts(WMA_SLUGS);
				this.applyOverlays();
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			wmas = parseNodeStoreIndex(await res.json(), WMA_SLUGS).wmas;
		} catch (e) {
			if (current()) this.nodeStoreNote = `Nodes added on the site could not be read (${(e as Error).message}). The built-in nodes are shown.`;
			return;
		}
		const held = this.overlays;
		const read = await Promise.all(
			Object.entries(wmas).map(async ([wma, entry]): Promise<[string, WmaOverlay | Error, boolean]> => {
				if (held[wma] && held[wma].updatedAt === entry.updatedAt && wma !== changed) return [wma, held[wma], false];
				try {
					const res = await siteFetch(asset(nodeStorePath.wma(wma) as never), { cache: 'no-cache' });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return [wma, parseWmaOverlay(await res.json(), wma, WMA_SLUGS), true];
				} catch (e) {
					return [wma, e as Error, true];
				}
			})
		);
		if (!current()) return;
		const overlays: Record<string, WmaOverlay> = {};
		const failed: string[] = [];
		for (const [wma, got] of read) {
			if (got instanceof Error) failed.push(`${wmaBySlug(wma)?.name ?? wma} (${got.message})`);
			else overlays[wma] = got;
		}
		this.forgetTexts([...read.filter(([, , fresh]) => fresh).map(([w]) => w), ...Object.keys(held).filter((w) => !(w in wmas))]);
		this.overlays = overlays;
		this.nodeStoreNote = failed.length ? `Nodes added on the site could not be read for ${failed.join('; ')}. The built-in nodes are shown there.` : '';
		this.applyOverlays();
	}

	/** Drop the texts read for these WMAs' uploaded nodes, whose files may have changed. */
	private forgetTexts(wmas: string[]) {
		for (const id of Object.keys(this.uploadedTexts)) if (wmas.some((w) => id.startsWith(`${w}:`))) delete this.uploadedTexts[id];
	}

	/** An uploaded node's texts, read once, as `ewr-<basin>.json` is; a failed read is tried again next time. */
	private textsOfUploaded(n: EwrNode, wma: string): Promise<ReadTexts> {
		const key = nodeKey(n.id, wma);
		if (key === null) return Promise.reject(new Error(`${n.label} has no files in the node store.`));
		return (this.uploadedTexts[n.id] ??= siteFetch(asset(nodeStorePath.files(wma, key) as never), { cache: 'no-cache' })
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return readNodeTexts(await r.json(), n, wma);
			})
			.catch((e) => {
				delete this.uploadedTexts[n.id];
				throw new Error(`The files of ${n.label} could not be read from the node store: ${(e as Error).message}`);
			}));
	}

	/** Every EWR text of a node, by file name: its basin's store, or an uploaded node's own. */
	private async textsOf(n: EwrNode): Promise<{ texts: Record<string, string>; missing: string[] }> {
		const wma = this.uploadedWma.get(n.id);
		if (wma) return this.textsOfUploaded(n, wma);
		return { texts: await this.store(n.basin, 'ewr'), missing: [] };
	}

	/** Write one node to the store (admins), then read its WMA again, so what is shown is what everyone sees. */
	async saveNode(wma: string, node: EwrNode, texts: NodeTexts): Promise<void> {
		try {
			await saveNode(wma, node, texts);
		} finally {
			await this.loadNodeStore(wma);
		}
	}

	/** Ask to delete a node (admins): its confirmation opens. */
	askDelete(id: string) {
		this.deleting = id;
	}

	/** Delete a node (admins): an uploaded one leaves the store, and a built-in one is hidden. Then its WMA is read again. */
	async deleteNode(id: string): Promise<void> {
		const n = this.byId.get(id);
		const wma = n && this.wmaOf(n);
		if (!n || !wma) throw new Error('That node is on no WMA\'s map, so it cannot be deleted here.');
		try {
			await deleteNode(wma, id);
		} finally {
			await this.loadNodeStore(wma);
		}
	}

	/** Show a deleted built-in node again (admins). */
	async restoreNode(wma: string, id: string): Promise<void> {
		try {
			await restoreNode(wma, id);
		} finally {
			await this.loadNodeStore(wma);
		}
	}

	/**
	 * The store's index. The app works without it: a copy of the site with no store, such as `pnpm dev`, gets a
	 * 404, and the DWS source then says the store is not there. Revalidated, as the store changes every day.
	 */
	private async loadDws(): Promise<void> {
		try {
			const res = await siteFetch(asset(dwsPath.index as never), { cache: 'no-cache' });
			this.dws = res.ok ? { status: 'ready', index: parseDwsIndex(await res.json()) } : dwsUnavailable(res.status);
		} catch (e) {
			this.dws = dwsUnavailable(null, (e as Error).message);
		}
		if (this.selected) {
			this.syncHistSource();
			this.syncDaySource();
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
		return (this.stores[key] ??= siteFetch(asset(`data/${key}.json` as never))
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
		const wma = this.uploadedWma.get(n.id);
		if (wma) {
			const { texts } = await this.textsOfUploaded(n, wma);
			if (!Object.hasOwn(texts, f.name)) throw new Error(`${f.name} is listed for ${n.label}, but the node store has no text for it, so it cannot be read. An admin can save the node again with its files.`);
			return texts[f.name];
		}
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
			// An uploaded node's files can be a write behind its listing: a file with no text is said, never guessed at.
			const read = lines?.tab || (this.uploadedWma.has(n.id) && n.files.length) ? await this.textsOf(n) : null;
			if (seq !== this.seq) return;
			this.lines = lines;
			const missing = read?.missing ?? [];
			this.notices = [
				...buildNotices(n, v, this.ecBasis, c, lines, lines?.tab && read && !missing.length ? read.texts : null),
				...(missing.length ? [{ level: 'warn' as const, text: `The node store has no text for ${missing.join(', ')}, so ${missing.length === 1 ? 'it' : 'they'} cannot be read. An admin can save the node again with its files.` }] : [])
			];
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
		this.syncDaySource();
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

	/** The daily record and the 12-minute readings come from the same gauge file, and choose their source the same way. */
	private syncFlowSource(view: DayView, slot: FlowSlot, want: 'daily' | 'instant', set: (s: FlowSource) => void) {
		const station = this.link && this.flowStations.has(this.link.station) ? this.link.station : null;
		const dws = this.dwsOk(want);
		if (view.source === 'gauge' && !station) set(dws ? 'dws' : 'sheet');
		else if (view.source === 'dws' && !dws) set(station ? 'gauge' : 'sheet');
		else if (station && view.source !== 'gauge' && view.source !== 'dws' && !slot.flow) view.source = 'gauge';
		if (station) void this.loadFlows(station);
		if (view.source === 'dws') void this.loadDwsFlows();
	}

	private syncDaySource() {
		this.syncFlowSource(this.dayView, this.day, 'daily', (s) => this.setDaySource(s));
	}

	private syncRtSource() {
		this.syncFlowSource(this.rtView, this.rt, 'instant', (s) => this.setRtSource(s));
	}

	setDaySource(source: FlowSource) {
		this.dayView.source = source;
		this.dayView.month = 'all';
		if (source === 'dws') void this.loadDwsFlows();
	}

	setRtSource(source: FlowSource) {
		this.rtView.source = source;
		this.rtView.month = 'all';
		if (source === 'dws') void this.loadDwsFlows();
	}

	/** Show one of the Historical Comparison's views, on its tab. */
	showHist(step: HistStep) {
		this.tab = 'hist';
		this.histStep = step;
	}

	/** Fetch one file of the store, revalidated, or throw with its HTTP status. */
	private async dwsFile<T>(path: string): Promise<T> {
		const res = await siteFetch(asset(path as never), { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as T;
	}

	/** The store's daily flow and readings for the selected node's gauge, read once, for both comparisons. A failure is said, and tried again next time. */
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
			const res = await siteFetch(asset(`data/flows-${station}.json` as never));
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

	setDay(slot: FlowSlot) {
		this.day = slot;
		if (slot.flow) this.dayView.month = 'all';
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
