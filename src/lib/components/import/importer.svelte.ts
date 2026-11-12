// The import panel's state (#17, P4): an admin's node KML and folder of Desktop outputs for one WMA,
// matched as they load, changed by hand, and saved node by node to the API. Nothing leaves the browser
// until Save. The matching, attaching and EC decisions are src/lib/ewr/uploadMatch.ts; this only holds
// what was loaded and calls it. One per visit to the page (NodeImport.svelte makes it).
import type { FeatureCollection, Position } from 'geojson';
import { parseKml, type KmlSkip, type Placemark } from '#lib/ewr/kml.ts';
import { NODE_STORE_LIMITS } from '#lib/ewr/nodeStore.ts';
import { attachFile, classify, detachFile, matchUpload, overrideEc, type UploadResult } from '#lib/ewr/uploadMatch.ts';
import { loadWma, outlineOf } from '#lib/components/map/catchments.ts';
import { BASIN_WMA, inRings, wmaBySlug, type Wma } from '#lib/components/map/wma.ts';
import { ApiError, saveNode, SignedOut } from '#lib/users/api.ts';

export type Message = { level: 'info' | 'warning' | 'error'; text: string };

/** The basins the app already places in a WMA, offered for its nodes. A WMA with none takes its own name. */
export const basinsOf = (wma: string): string[] => Object.keys(BASIN_WMA).filter((b) => BASIN_WMA[b] === wma);

/** What the API's refusals that stop a save mean here. A 503 is the API without its store, or with sign-in not set up yet. */
export const NOT_READY = 'The site cannot store nodes yet: the server is not ready (HTTP 503). Nothing more was sent. Try again once the node store is live.';
export const NO_STORE = 'The site has no node store, or your account is no longer an admin (HTTP 404). Nothing more was sent.';

/** A file read from the folder, or one left unread and why. */
interface Loaded {
	name: string;
	text: string;
}

export class Importer {
	wma = $state('');
	basin = $state('');
	/** The KML's file name, and what it gave. */
	kmlName = $state('');
	placemarks = $state.raw<Placemark[]>([]);
	kmlSkipped = $state.raw<KmlSkip[]>([]);
	kmlMessage = $state<Message | null>(null);
	/** The folder's files, read as the build reads them; Desktop outputs only, the rest by name with no text. */
	files = $state.raw<Loaded[]>([]);
	filesMessage = $state<Message | null>(null);
	/** Files over the store's size limit for one file, left out before matching. */
	tooLarge = $state.raw<string[]>([]);
	reading = $state(false);

	result = $state.raw<UploadResult | null>(null);
	/** The last thing an attach, detach or EC choice said, or why it failed. */
	editMessage = $state<Message | null>(null);
	/** The node whose panel is open. */
	selected = $state<string | null>(null);

	/** The WMA's live outline, for the map and the inside check: null while asked for, or once lost. */
	boundary = $state.raw<FeatureCollection | null>(null);
	boundaryState = $state<'none' | 'loading' | 'loaded' | 'lost'>('none');

	includeEmpty = $state(true);
	saving = $state(false);
	progress = $state<{ done: number; total: number } | null>(null);
	/** Node ids saved since the match last changed them. */
	saved = $state.raw<Set<string>>(new Set());
	failures = $state.raw<{ id: string; text: string }[]>([]);
	/** Why the last save stopped before the end, if it did. */
	stopped = $state('');

	/** The outline's rings, for `outside`. */
	#rings: Position[][] | null = null;
	#outlineRequest = 0;

	readonly area = $derived<Wma | undefined>(wmaBySlug(this.wma));
	/** Nodes whose point is outside the WMA's outline: a warning, never a refusal. Empty until the outline loads. */
	readonly outside = $derived.by(() => {
		const r = this.result;
		const rings = this.boundaryState === 'loaded' ? this.#rings : null;
		if (!r || !rings) return new Set<string>();
		return new Set(r.nodes.filter((n) => n.lon !== null && n.lat !== null && !inRings([n.lon, n.lat], rings)).map((n) => n.id));
	});
	readonly overLimit = $derived(new Set((this.result?.report.overLimits ?? []).map((o) => o.nodeId).filter(Boolean)));
	/** The nodes Save sends: not yet saved, under the limits, and with data unless nodes with none are included. */
	readonly toSave = $derived(
		(this.result?.nodes ?? []).filter((n) => !this.saved.has(n.id) && !this.overLimit.has(n.id) && (this.includeEmpty || n.files.length > 0))
	);

	/** Choose the WMA: its outline is asked for, and what was loaded is matched again for it. */
	setWma(slug: string) {
		this.wma = slug;
		const basins = basinsOf(slug);
		this.basin = basins[0] ?? wmaBySlug(slug)?.name ?? '';
		this.#loadOutline();
		const edited = this.#edited;
		this.#match();
		if (edited && this.result) this.editMessage = { level: 'warning', text: 'The files were matched again for this WMA: files attached and ECs set by hand were cleared.' };
	}

	/** Every node of this import goes in this basin. */
	setBasin(basin: string) {
		this.basin = basin;
		const r = this.result;
		if (r) this.#change({ ...r, nodes: r.nodes.map((n) => ({ ...n, basin })) }, r.nodes.map((n) => n.id));
	}

	async loadKml(file: File | undefined) {
		if (!file) return;
		this.kmlMessage = null;
		try {
			const parsed = parseKml(await file.text());
			this.kmlName = file.name;
			this.placemarks = parsed.placemarks;
			this.kmlSkipped = parsed.skipped;
			this.#match();
		} catch (e) {
			this.kmlMessage = { level: 'error', text: `Could not read ${file.name}: ${(e as Error).message}` };
		}
	}

	/**
	 * A folder's files, or several chosen. A Desktop output by its name is read as latin-1, as the build
	 * reads it; one over the store's limit for a file is left out and listed. Anything else is kept by
	 * name only, so the report says why it was not used, without reading it.
	 */
	async loadFiles(list: FileList | null) {
		if (!list?.length) return;
		this.reading = true;
		this.filesMessage = null;
		try {
			const latin1 = new TextDecoder('latin1');
			const tooLarge: string[] = [];
			const files: Loaded[] = [];
			for (const f of Array.from(list)) {
				const path = f.webkitRelativePath || f.name;
				if (!classify(f.name)) {
					files.push({ name: path, text: '' });
				} else if (f.size > NODE_STORE_LIMITS.fileChars) {
					tooLarge.push(path);
				} else {
					files.push({ name: path, text: latin1.decode(await f.arrayBuffer()) });
				}
			}
			this.files = files;
			this.tooLarge = tooLarge;
			this.#match();
		} catch (e) {
			this.filesMessage = { level: 'error', text: `Could not read the files: ${(e as Error).message}` };
		} finally {
			this.reading = false;
		}
	}

	attach(nodeId: string, file: string) {
		this.#edit(() => attachFile(this.result!, nodeId, file), nodeId, `Attached ${file} to ${this.#label(nodeId)}.`);
	}

	detach(nodeId: string, file: string) {
		this.#edit(() => detachFile(this.result!, nodeId, file), nodeId, `Took ${file} off ${this.#label(nodeId)}. It is with the unmatched files.`);
	}

	setEc(nodeId: string, file: string, ec: string) {
		this.#edit(() => overrideEc(this.result!, nodeId, file, ec), nodeId, `${file} is treated as ${ec} now.`);
	}

	/** Send each node to the API, one request each, in order. A 503 or 404 stops it: every other node would get the same. */
	async save() {
		const r = this.result;
		if (!r || this.saving) return;
		const todo = this.toSave;
		const wma = this.wma;
		this.saving = true;
		this.stopped = '';
		this.failures = [];
		this.progress = { done: 0, total: todo.length };
		const saved = new Set(this.saved);
		const failures: { id: string; text: string }[] = [];
		try {
			for (const n of todo) {
				try {
					await saveNode(wma, n, r.texts[n.id] ?? {});
					saved.add(n.id);
				} catch (e) {
					if (e instanceof SignedOut) return;
					if (e instanceof ApiError && (e.status === 503 || e.status === 404)) {
						this.stopped = `${e.status === 503 ? NOT_READY : NO_STORE} The server said: ${e.message}`;
						break;
					}
					failures.push({ id: n.id, text: (e as Error).message });
				}
				this.progress = { done: this.progress!.done + 1, total: todo.length };
				this.saved = new Set(saved);
				this.failures = [...failures];
			}
		} finally {
			this.saved = saved;
			this.failures = failures;
			this.saving = false;
		}
	}

	#label = (id: string) => this.result?.nodes.find((n) => n.id === id)?.label ?? id;

	/** Whether anything was attached, detached or set by hand since the last match. */
	#edited = false;

	#edit(work: () => UploadResult, nodeId: string, done: string) {
		if (!this.result || this.saving) return;
		try {
			this.#change(work(), [nodeId]);
			this.#edited = true;
			this.editMessage = { level: 'info', text: done };
		} catch (e) {
			this.editMessage = { level: 'error', text: (e as Error).message };
		}
	}

	/** A changed result: the nodes it changed must be saved again. */
	#change(result: UploadResult, changed: string[]) {
		this.result = result;
		const saved = new Set(this.saved);
		for (const id of changed) saved.delete(id);
		this.saved = saved;
	}

	#match() {
		this.#edited = false;
		this.editMessage = null;
		this.saved = new Set();
		this.failures = [];
		this.stopped = '';
		this.progress = null;
		if (!this.wma || !this.placemarks.length) {
			this.result = null;
			return;
		}
		this.result = matchUpload({ wma: this.wma, basin: this.basin, placemarks: this.placemarks, files: this.files, kmlSkipped: this.kmlSkipped });
		if (this.selected && !this.result.nodes.some((n) => n.id === this.selected)) this.selected = null;
	}

	#loadOutline() {
		const area = this.area;
		const id = ++this.#outlineRequest;
		this.boundary = null;
		this.#rings = null;
		if (!area) {
			this.boundaryState = 'none';
			return;
		}
		this.boundaryState = 'loading';
		loadWma(area).then(
			(fc) => {
				if (id !== this.#outlineRequest) return;
				this.#rings = outlineOf(fc);
				this.boundary = fc;
				this.boundaryState = 'loaded';
			},
			() => {
				if (id === this.#outlineRequest) this.boundaryState = 'lost';
			}
		);
	}
}
