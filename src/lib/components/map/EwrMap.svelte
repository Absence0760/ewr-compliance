<!--
	One WMA's map: its catchments, rivers, flow gauges, basins, EWR nodes and sites, with a popup
	for each point and river, basin zoom, search and a legend. It fills the left column of the WMA route.
	The canvas is drawn by MapLibre, which is loaded when this mounts (maplibre.ts). Points are
	picked by position rather than per-layer events, so the nearest of a dense cluster wins and a
	diamond is hit across its full width. The search is the keyboard route to every point.
-->
<script module lang="ts">
	// Survives remounts: coming back to this route must not replay an old request.
	let handledFocus = 0;
</script>

<script lang="ts">
	import { mount, onMount, unmount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { asset, resolve } from '$app/paths';
	import type { FeatureCollection } from 'geojson';
	import type { GeoJSONSource, GeoJSONSourceSpecification, LngLatLike, MapGeoJSONFeature, Marker, Popup, PointLike } from 'maplibre-gl';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import { app } from '#lib/state/app.svelte.ts';
	import { siteFetch } from '#lib/users/siteFetch.ts';
	import type { EwrNode, EwrSite } from '#lib/ewr/types.ts';
	import { loadBasins, loadGauges, loadQuaternaries, loadWma, namedQuaternaries, outlineOf, type Gauge } from '#lib/components/map/catchments.ts';
	import { WMAS, wmaOfBasin, type Wma } from '#lib/components/map/wma.ts';
	import { session } from '#lib/state/session.svelte.ts';
	import { nodeRefusal } from '#lib/users/api.ts';
	import AddNodeDialog from '#lib/components/map/AddNodeDialog.svelte';
	import MapLegend from '#lib/components/map/MapLegend.svelte';
	import NodePopup, { type River } from '#lib/components/map/NodePopup.svelte';
	import {
		basinBounds, boundsOf, findEntry, gaugeLabels, labelPoints, nodeFeatures, searchEntries, siteFeatures, type Bounds, type MapLabel
	} from '#lib/components/map/mapData.ts';
	import {
		BASEMAP_SOURCE, BASINS, CREDIT, DIAMOND, FIRST_LABEL, GAUGE_CLOSED_ICON, GAUGE_ICON, GAUGES, GAUGES_CLOSED, MINOR_RIVERS, NO_FILE,
		NODES, OVERLAY_LAYERS, POINT_LAYERS, QUAT_FILL, QUAT_LINES, RIVER_LABEL_LAYER, RIVER_LABELS, RIVERS, SITES, baseStyle, basemapLayerIds,
		diamondImage, gaugeImage, tileUrl
	} from '#lib/components/map/mapStyle.ts';

	let { wma }: { wma: Wma } = $props();

	const LABEL_ZOOM = 9;
	const FOCUS_ZOOM = 10;
	const PICK_RADIUS = 9;
	const FIT = { padding: 30, duration: 500 };
	/** The map's notice for each live layer it lost, in the order they are read out. */
	const LOST_WMA = 'The WMA boundary could not be loaded from the DWS service.';
	const LOST_QUATERNARIES = 'Quaternary catchments could not be loaded from the DWS service.';
	const LOST_BASINS = 'Basin boundaries could not be loaded from the DWS service.';
	const LOST_GAUGES = 'Flow gauges could not be loaded.';

	let container: HTMLDivElement;
	let wrap = $state<HTMLElement>();
	let map: MapLibreMap | null = null;
	let ml: typeof import('#lib/components/map/maplibre.ts');
	let popup: Popup | null = null;
	let tip: Popup | null = null;
	const labelMarkers = new Map<string, Marker>();

	let ready = $state(false);
	let failure = $state('');
	let basins = $state.raw<{ name: string; bounds: Bounds }[]>([]);
	let allBounds: Bounds | null = null;
	let basin = $state('');
	let search = $state('');
	let searchMiss = $state('');
	/** A site found before the map is ready, opened once it is. */
	let pendingSite = $state.raw<EwrSite | null>(null);

	let showQuaternaries = $state(true);
	let showRivers = $state(true);
	let showNoFile = $state(false);
	let showGauges = $state(true);
	let showClosedGauges = $state(false);
	let showBasemap = $state(true);
	let basemapFailed = $state(false);
	let lostLive = $state.raw<string[]>([]);
	/** Live layers asked for and not yet answered, loaded or lost. */
	let pendingLive = $state(0);
	let gauges = $state.raw<FeatureCollection | null>(null);
	/** The node the open popup shows, so it closes if the node goes. */
	let popupNode: string | null = null;

	/** Admins only: placing a new node by a click, its form, and restoring a deleted one. */
	let placing = $state(false);
	let adding = $state<{ at: { lon: number; lat: number } | null } | null>(null);
	let restoring = $state('');
	let restoreError = $state('');
	const admin = $derived(!!session.me?.admin);
	const hidden = $derived(app.hidden.filter((h) => h.wma === wma.slug));

	// A file beside the app, or any host allowing cross-origin range requests.
	// The app's root as a full URL: a setting that is a path is beside the app, wherever the page is.
	const root = new URL(asset('' as never), document.baseURI).href;
	const tilesUrl = tileUrl(import.meta.env.VITE_TILES_URL, root);
	const glyphs = tileUrl(import.meta.env.VITE_TILES_GLYPHS_URL, root);
	const style = baseStyle(tilesUrl, glyphs);

	/**
	 * The nodes and sites of this WMA. Every map is of one WMA, and the app's data may cover several. A node
	 * added on the site is its overlay's WMA's, whatever its basin (app.wmaOf).
	 */
	const inWma = (n: EwrNode) => app.wmaOf(n) === wma.slug;
	const nodes = $derived(app.nodes.filter(inWma));
	const sites = $derived(app.sites.filter((s) => wmaOfBasin(s.basin)?.slug === wma.slug));
	const entries = $derived(searchEntries(nodes, sites));
	const liveNote = $derived(
		lostLive.length ? `${[LOST_WMA, LOST_QUATERNARIES, LOST_BASINS, LOST_GAUGES].filter((l) => lostLive.includes(l)).join(' ')} Everything else still works.` : ''
	);
	const labels = $derived([...labelPoints(nodes, sites, showNoFile), ...gaugeLabels(gauges, showGauges, showClosedGauges)]);

	onMount(() => {
		let gone = false;
		void start(() => gone);
		return () => {
			gone = true;
			ready = false;
			popup?.remove();
			map?.remove();
			map = null;
			labelMarkers.clear();
		};
	});

	async function start(gone: () => boolean) {
		try {
			// One per WMA, written by tools/build-rivers.ts.
			const riversFile = `geo/rivers-${wma.slug}.json` as Parameters<typeof asset>[0];
			const [lib, res] = await Promise.all([import('#lib/components/map/maplibre.ts'), siteFetch(asset(riversFile))]);
			if (!res.ok) throw new Error(`${riversFile}: HTTP ${res.status}`);
			const rivers = (await res.json()) as FeatureCollection;
			if (gone()) return;
			ml = lib;
			if (tilesUrl) await ml.usePmtiles();
			if (gone()) return;
			basins = basinBounds(nodes);
			// A WMA with nodes opens on them, and one without on the whole area.
			allBounds = basins.length ? boundsOf(basins.map((b) => b.bounds)) : wma.bounds;
			const m = new ml.MapLibreMap({
				container,
				style,
				bounds: allBounds,
				fitBoundsOptions: { padding: 30 },
				dragRotate: false,
				pitchWithRotate: false,
				attributionControl: { compact: false, customAttribution: CREDIT }
			});
			map = m;
			m.touchZoomRotate.disableRotation();
			m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
			tip = new ml.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 12, className: 'ewr-tip' });
			m.on('error', onError);
			m.on('load', () => {
				m.addImage(DIAMOND, diamondImage(), { pixelRatio: 2 });
				m.addImage(GAUGE_ICON, gaugeImage(false), { pixelRatio: 2 });
				m.addImage(GAUGE_CLOSED_ICON, gaugeImage(true), { pixelRatio: 2 });
				const source = (data: unknown) => ({ type: 'geojson', data }) as GeoJSONSourceSpecification;
				const empty = { type: 'FeatureCollection', features: [] };
				m.addSource('quaternaries', source(empty));
				m.addSource('rivers', source(rivers));
				m.addSource('wma', source(empty));
				m.addSource('basins', source(empty));
				m.addSource('nodes', source(nodeFeatures(nodes)));
				m.addSource('sites', source(siteFeatures(sites, nodes)));
				m.addSource('gauges', source(empty));
				const under = tilesUrl && glyphs ? FIRST_LABEL : undefined;
				for (const layer of OVERLAY_LAYERS) m.addLayer(layer, POINT_LAYERS.includes(layer.id) ? undefined : under);
				// River names need glyphs, which come with the base map. They sit under the points.
				if (glyphs) m.addLayer(RIVER_LABEL_LAYER, POINT_LAYERS[0]);
				if (tilesUrl) m.setPaintProperty(QUAT_FILL, 'fill-opacity', 0.12);
				loadLive(m);
				m.on('click', onClick);
				m.on('mousemove', onHover);
				m.on('mouseout', () => tip?.remove());
				m.on('moveend', syncLabels);
				ready = true;
			});
		} catch (e) {
			failure = `The map could not be drawn: ${(e as Error).message}. The Nodes and ECs table still lists every node.`;
		}
	}

	/**
	 * The live layers arrive after the map is up, and the map still works without them. Each is
	 * handled alone, so a slow or dead service never holds back the others.
	 */
	function loadLive(m: MapLibreMap) {
		const live = (load: () => Promise<FeatureCollection>, lost: string, use: (fc: FeatureCollection) => void) => {
			pendingLive++;
			return load()
				.then(
					(fc) => {
						if (map === m) use(fc);
					},
					() => {
						if (map === m) lostLive = [...lostLive, lost];
					}
				)
				.finally(() => {
					if (map === m) pendingLive--;
				});
		};
		const set = (id: string, data: FeatureCollection) => (m.getSource(id) as GeoJSONSource).setData(data);
		// Catchments and gauges are asked for by the WMA's box and kept by its outline. Without the
		// outline, which is reported, they are kept by the box alone.
		// Read now: the callbacks below can run after the page has moved on, when props are stale.
		const area = wma;
		const boundary = loadWma(area);
		void live(() => boundary, LOST_WMA, (fc) => set('wma', fc));
		const outline = boundary.then(outlineOf, () => null);
		const named = namedQuaternaries(nodes);
		void live(() => outline.then((o) => loadQuaternaries(area, o, named)), LOST_QUATERNARIES, (fc) => set('quaternaries', fc));
		void live(() => outline.then((o) => loadGauges(area, o)), LOST_GAUGES, (fc) => {
			set('gauges', fc);
			gauges = fc;
		});
		// The 2004 basin outlines are drawn where there are nodes, to go with the basin zoom.
		if (nodes.length) void live(loadBasins, LOST_BASINS, (fc) => set('basins', fc));
	}

	function onError(e: { error: { message: string } }) {
		if ((e as { sourceId?: string }).sourceId === BASEMAP_SOURCE) {
			basemapFailed = true;
			showBasemap = false;
		} else {
			console.error(e.error);
		}
	}

	/** Points near the pixel, nearest first. Ties keep MapLibre's order, which is topmost first. */
	function pointsNear(p: { x: number; y: number }): MapGeoJSONFeature[] {
		const box: [PointLike, PointLike] = [
			[p.x - PICK_RADIUS, p.y - PICK_RADIUS],
			[p.x + PICK_RADIUS, p.y + PICK_RADIUS]
		];
		const m = map!;
		const away = (f: MapGeoJSONFeature) => {
			const q = m.project(lngLatOf(f));
			return Math.hypot(q.x - p.x, q.y - p.y);
		};
		return m
			.queryRenderedFeatures(box, { layers: [NODES, NO_FILE, SITES, GAUGES, GAUGES_CLOSED] })
			.map((f) => ({ f, d: away(f) }))
			.sort((a, b) => a.d - b.d)
			.map((x) => x.f);
	}

	const lngLatOf = (f: MapGeoJSONFeature) => (f.geometry as unknown as { coordinates: [number, number] }).coordinates;

	function onClick(e: { point: { x: number; y: number }; lngLat: LngLatLike }) {
		if (placing) {
			const { lng, lat } = e.lngLat as { lng: number; lat: number };
			placing = false;
			adding = { at: { lon: lng, lat } };
			return;
		}
		const f = pointsNear(e.point)[0];
		if (!f) {
			const river = riverAt(e.point);
			if (river) openPopup({ river }, e.lngLat);
			return;
		}
		const at = lngLatOf(f);
		if (f.layer.id === GAUGES || f.layer.id === GAUGES_CLOSED) {
			app.showGauge(f.properties.station, f.properties.name);
			openPopup({ gauge: f.properties as Gauge }, at);
			return;
		}
		if (f.layer.id !== SITES) {
			activate(f.properties.id, at);
			return;
		}
		if (f.properties.node) activate(f.properties.node, at);
		else openPopup({ site: sites[f.properties.i] }, at);
	}

	function activate(id: string, at: LngLatLike) {
		app.select(id);
		const node = app.byId.get(id);
		if (node) openPopup({ node }, at);
	}

	function onHover(e: { point: { x: number; y: number }; lngLat: LngLatLike }) {
		const m = map!;
		const near = pointsNear(e.point);
		m.getCanvas().style.cursor = placing ? 'crosshair' : near.length || riverAt(e.point) ? 'pointer' : '';
		const text = near[0]?.properties.label ?? riverOrQuaternaryAt(e.point);
		if (text) tip?.setLngLat(e.lngLat).setText(text).addTo(m);
		else tip?.remove();
	}

	/** The river drawn under the pixel, named first, then the larger. */
	function riverAt(p: { x: number; y: number }): River | null {
		if (!showRivers) return null;
		const near = map!.queryRenderedFeatures([[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]], { layers: [RIVERS, MINOR_RIVERS] });
		const f = near.sort((a, b) => Number(!!b.properties.n) - Number(!!a.properties.n) || (b.properties.s ?? 1) - (a.properties.s ?? 1))[0];
		return f ? { name: f.properties.n ?? '', order: f.properties.s ?? 1, flow: f.properties.c ?? '' } : null;
	}

	function riverOrQuaternaryAt(p: { x: number; y: number }): string {
		const name = riverAt(p)?.name;
		if (name) return name;
		return showQuaternaries ? (map!.queryRenderedFeatures([p.x, p.y], { layers: [QUAT_FILL] })[0]?.properties.q ?? '') : '';
	}

	function openPopup(content: { node?: EwrNode; site?: EwrSite; gauge?: Gauge; river?: River }, at: LngLatLike) {
		popup?.remove();
		const el = document.createElement('div');
		const body = mount(NodePopup, { target: el, props: content });
		// A popup requested while the map loaded opens later: by then focus may have moved on, and stays.
		const active = document.activeElement;
		const focusAfterOpen = !active || active === document.body || !!wrap?.contains(active);
		const opened = new ml.Popup({ maxWidth: '320px', offset: 10, focusAfterOpen }).setLngLat(at).setDOMContent(el).addTo(map!);
		opened.once('close', () => {
			void unmount(body);
			if (popup === opened) {
				popup = null;
				popupNode = null;
			}
		});
		popup = opened;
		popupNode = content.node?.id ?? null;
	}

	function flyAndOpen(content: { node?: EwrNode; site?: EwrSite }, at: [number, number]) {
		map!.flyTo({ center: at, zoom: Math.max(map!.getZoom(), FOCUS_ZOOM) });
		openPopup(content, at);
	}

	/** Labels are DOM markers, kept to the area around the view so panning stays smooth. */
	function syncLabels() {
		const m = map;
		if (!m) return;
		const want = new Map<string, MapLabel>();
		if (m.getZoom() >= LABEL_ZOOM) {
			const b = m.getBounds();
			const padX = (b.getEast() - b.getWest()) / 2;
			const padY = (b.getNorth() - b.getSouth()) / 2;
			for (const l of labels) {
				const [x, y] = l.lngLat;
				if (x > b.getWest() - padX && x < b.getEast() + padX && y > b.getSouth() - padY && y < b.getNorth() + padY) {
					want.set(l.key, l);
				}
			}
		}
		for (const [key, marker] of labelMarkers) {
			if (want.has(key)) continue;
			marker.remove();
			labelMarkers.delete(key);
		}
		for (const [key, l] of want) {
			if (labelMarkers.has(key)) continue;
			const el = document.createElement('div');
			// Gauge labels sit left of the point: a gauge is often at a node, whose label runs right.
			const gauge = key.startsWith('gauge:');
			el.className = gauge ? 'ewr-label gauge' : 'ewr-label';
			el.textContent = l.text;
			const place = gauge ? { anchor: 'right' as const, offset: [-8, 0] as [number, number] } : { anchor: 'left' as const, offset: [9, 0] as [number, number] };
			labelMarkers.set(key, new ml.Marker({ element: el, ...place }).setLngLat(l.lngLat).addTo(m));
		}
	}

	function setVisible(layers: string[], on: boolean) {
		for (const id of layers) map!.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
	}

	$effect(() => {
		if (!ready) return;
		setVisible([QUAT_FILL, QUAT_LINES], showQuaternaries);
		setVisible(glyphs ? [RIVERS, MINOR_RIVERS, RIVER_LABELS] : [RIVERS, MINOR_RIVERS], showRivers);
		setVisible([NO_FILE], showNoFile);
		setVisible([GAUGES], showGauges);
		setVisible([GAUGES_CLOSED], showClosedGauges);
	});

	// A node's label text can change when the no-file layer switches a site's label on or off.
	$effect(() => {
		void labels;
		if (ready) untrack(syncLabels);
	});

	$effect(() => {
		if (!ready) return;
		const m = map!;
		for (const id of basemapLayerIds(style)) m.setLayoutProperty(id, 'visibility', showBasemap ? 'visible' : 'none');
	});

	$effect(() => {
		const f = app.focus;
		if (!ready || !f || f.n === handledFocus) return;
		handledFocus = f.n;
		const node = app.byId.get(f.id);
		// A node of another WMA is found on that WMA's map.
		if (node && inWma(node) && node.lon !== null && node.lat !== null) untrack(() => flyAndOpen({ node }, [node.lon!, node.lat!]));
	});

	// The node store is read after the map starts, and changes when an admin adds, deletes or restores a node.
	$effect(() => {
		const ns = nodes;
		const ss = sites;
		if (!ready) return;
		untrack(() => {
			const m = map!;
			(m.getSource('nodes') as GeoJSONSource).setData(nodeFeatures(ns) as never);
			(m.getSource('sites') as GeoJSONSource).setData(siteFeatures(ss, ns) as never);
			basins = basinBounds(ns);
			if (popupNode && !app.byId.has(popupNode)) popup?.remove();
		});
	});

	$effect(() => {
		const site = pendingSite;
		if (!ready || !site) return;
		pendingSite = null;
		untrack(() => flyAndOpen({ site }, [site.lon, site.lat]));
	});

	function zoomToBasin() {
		const bounds = basins.find((b) => b.name === basin)?.bounds ?? allBounds;
		if (bounds) map?.fitBounds(bounds, FIT);
	}

	function runSearch() {
		const entry = findEntry(entries, search);
		searchMiss = !entry && search.trim() ? search.trim() : '';
		if (!entry) return;
		search = '';
		if (entry.target.kind === 'node') {
			app.select(entry.target.id, { focus: true });
		} else {
			pendingSite = sites[entry.target.index];
		}
	}

	function startPlacing() {
		app.nodeStoreDone = '';
		placing = !placing;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && placing) placing = false;
	}

	$effect(() => {
		if (ready) map!.getCanvas().style.cursor = placing ? 'crosshair' : '';
	});

	async function restore(id: string) {
		restoring = id;
		restoreError = '';
		app.nodeStoreDone = '';
		const label = hidden.find((h) => h.node.id === id)?.node.label ?? id;
		try {
			await app.restoreNode(wma.slug, id);
			app.nodeStoreDone = `Restored ${label}.`;
		} catch (e) {
			restoreError = nodeRefusal(e);
		} finally {
			restoring = '';
		}
	}

	function changeWma(slug: string) {
		void goto(slug ? resolve(`wma/${slug}/` as '/') : resolve('/'));
	}
</script>

<svelte:window onkeydown={onKey} />

<section class="wrap" aria-label="Map of EWR nodes and sites" bind:this={wrap}>
	<!-- Busy until the map is drawn and every live layer has answered, loaded or lost, or it could not start. -->
	<div class="map" bind:this={container} aria-busy={!failure && (!ready || pendingLive > 0)}></div>
	<div class="bar">
		<select aria-label="Water Management Area" value={wma.slug} onchange={(e) => changeWma(e.currentTarget.value)}>
			<option value="">All WMAs</option>
			{#each WMAS as w (w.slug)}
				<option value={w.slug}>{w.name}</option>
			{/each}
		</select>
		{#if basins.length}
			<select aria-label="Zoom to a basin" bind:value={basin} onchange={zoomToBasin}>
				<option value="">All basins</option>
				{#each basins as b (b.name)}
					<option value={b.name}>{b.name}</option>
				{/each}
			</select>
		{/if}
		<input
			type="search"
			aria-label="Find a node or site"
			placeholder="Find a node or site"
			list="ewr-map-search"
			bind:value={search}
			onchange={runSearch}
		/>
		<datalist id="ewr-map-search">
			{#each entries as e (e.value)}
				<option value={e.value}></option>
			{/each}
		</datalist>
		{#if searchMiss}
			<span class="miss" role="status">No node or site called {searchMiss}</span>
		{/if}
		{#if admin}
			<button type="button" class="tool" aria-pressed={placing} onclick={startPlacing} disabled={!ready}>Add node</button>
			{#if hidden.length}
				<details class="tool deleted">
					<summary>Deleted nodes ({hidden.length})</summary>
					<div class="drop">
						<p class="muted">Hidden from everyone until restored.</p>
						<ul>
							{#each hidden as h (h.node.id)}
								<li>
									<span><b>{h.node.label}</b> <span class="muted">{h.node.basin}{h.node.river ? `, ${h.node.river}` : ''}</span></span>
									<button type="button" disabled={!!restoring} onclick={() => restore(h.node.id)} aria-label="Restore {h.node.label}">
										{restoring === h.node.id ? 'Restoring…' : 'Restore'}
									</button>
								</li>
							{/each}
						</ul>
						{#if restoreError}<div class="notice error" role="alert">{restoreError}</div>{/if}
					</div>
				</details>
			{/if}
		{/if}
		{#if placing}
			<p class="line placing" role="status">
				Click the map where the new node is.
				<button type="button" onclick={() => ((placing = false), (adding = { at: null }))}>Type coordinates instead</button>
				<button type="button" onclick={() => (placing = false)}>Cancel</button>
			</p>
		{:else if admin && app.nodeStoreDone}
			<p class="line" role="status">{app.nodeStoreDone}</p>
		{/if}
		{#if app.nodeStoreNote}
			<p class="line quiet" role="status">{app.nodeStoreNote}</p>
		{/if}
	</div>
	{#if adding && admin}
		<AddNodeDialog
			{wma}
			at={adding.at}
			onclose={() => (adding = null)}
			onsaved={(id) => app.select(id, { focus: true })}
		/>
	{/if}
	{#if !nodes.length && !sites.length}
		<p class="empty" role="status">No EWR data for {wma.name} yet. Its catchments, rivers and flow gauges are shown.</p>
	{/if}
	<MapLegend
		bind:quaternaries={showQuaternaries}
		bind:rivers={showRivers}
		bind:noFile={showNoFile}
		bind:gauges={showGauges}
		bind:closedGauges={showClosedGauges}
		bind:basemap={showBasemap}
		hasNodes={nodes.length > 0 || sites.length > 0}
		hasBasemap={!!tilesUrl}
		{basemapFailed}
	/>
	{#if failure || liveNote}
		<p class="failure" role="alert">{failure || liveNote}</p>
	{/if}
</section>

<style>
	.wrap {
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		border-right: 1px solid #dddcd5;
	}
	.map {
		position: absolute;
		inset: 0;
		background: #eef0ee;
		font-family: inherit;
	}
	.bar {
		position: absolute;
		top: 10px;
		left: 48px;
		right: 10px;
		/* Over the legend, so the Deleted nodes list opens on top of it on a phone. */
		z-index: 4;
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
		pointer-events: none;
	}
	.bar select,
	.bar input {
		pointer-events: auto;
	}
	.bar .tool,
	.bar .line {
		pointer-events: auto;
	}
	.bar button.tool[aria-pressed='true'] {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.bar .line {
		flex-basis: 100%;
		margin: 0;
		padding: 4px 8px;
		background: rgba(252, 252, 251, 0.95);
		border-left: 3px solid var(--accent);
		border-radius: 0 4px 4px 0;
		font-size: 13px;
	}
	.bar .line button {
		margin-left: 6px;
		padding: 1px 8px;
		font-size: 12px;
	}
	.bar .line.quiet {
		border-left-color: var(--line);
		color: var(--ink-2);
	}
	.deleted summary {
		padding: 4px 8px;
		border: 1px solid #b9b8b0;
		border-radius: 5px;
		background: var(--surface-2);
		cursor: pointer;
	}
	.deleted .drop {
		position: absolute;
		/* Under the whole bar, from its left edge, so it is never cut off by the map's edge. */
		top: calc(100% + 4px);
		left: 0;
		z-index: 4;
		width: min(340px, 100%);
		max-height: 50vh;
		overflow: auto;
		padding: 8px 10px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
	}
	.deleted p {
		margin: 0 0 6px;
		font-size: 12px;
	}
	.deleted ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.deleted li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		border-top: 1px solid var(--line);
	}
	.bar input {
		flex: 1;
		min-width: 160px;
		max-width: 240px;
	}
	.empty {
		position: absolute;
		left: 48px;
		right: 10px;
		bottom: 28px;
		z-index: 3;
		margin: 0;
		padding: 6px 10px;
		background: rgba(252, 252, 251, 0.95);
		border-left: 3px solid var(--accent);
		font-size: 13px;
	}
	.miss {
		background: rgba(252, 252, 251, 0.95);
		border-radius: 4px;
		padding: 2px 6px;
		font-size: 12px;
	}
	.failure {
		position: absolute;
		inset: 60px 20px auto;
		z-index: 3;
		margin: 0;
		padding: 8px 10px;
		background: #fbeceb;
		border-left: 3px solid #b3261e;
		font-size: 13px;
	}
	.wrap :global(.maplibregl-popup) {
		z-index: 2;
	}
	.wrap :global(.ewr-label) {
		z-index: 1;
		pointer-events: none;
		background: rgba(255, 255, 255, 0.86);
		padding: 0 3px;
		font-size: 11px;
		line-height: 1.35;
		color: #0b0b0b;
		white-space: nowrap;
	}
	.wrap :global(.ewr-label.gauge) {
		color: #0a5e44;
	}
	.wrap :global(.ewr-tip) {
		z-index: 2;
	}
	.wrap :global(.ewr-tip .maplibregl-popup-content) {
		pointer-events: none;
		padding: 2px 6px;
		font-size: 12px;
	}
	.wrap :global(.ewr-tip .maplibregl-popup-tip) {
		display: none;
	}
	@media (max-width: 860px) {
		.wrap {
			height: 56vh;
			border-right: 0;
			border-bottom: 1px solid #dddcd5;
		}
	}
</style>
