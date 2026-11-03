<!--
	The map: catchments, rivers, basins, EWR nodes and sites, with a popup for each point, basin
	zoom, search and a legend. It fills the left column of the home route.
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
	import { asset } from '$app/paths';
	import type { FeatureCollection } from 'geojson';
	import type { GeoJSONSource, GeoJSONSourceSpecification, LngLatLike, MapGeoJSONFeature, Marker, Popup, PointLike } from 'maplibre-gl';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import { app } from '#lib/state/app.svelte.ts';
	import type { EwrNode, EwrSite } from '#lib/ewr/types.ts';
	import { loadBasins, loadGauges, loadQuaternaries, type Gauge } from '#lib/components/map/catchments.ts';
	import MapLegend from '#lib/components/map/MapLegend.svelte';
	import NodePopup from '#lib/components/map/NodePopup.svelte';
	import {
		basinBounds, boundsOf, findEntry, gaugeLabels, labelPoints, nodeFeatures, searchEntries, siteFeatures, type Bounds, type MapLabel
	} from '#lib/components/map/mapData.ts';
	import {
		BASEMAP_SOURCE, BASINS, CREDIT, DIAMOND, FIRST_LABEL, GAUGE_CLOSED_ICON, GAUGE_ICON, GAUGES, GAUGES_CLOSED, NO_FILE, NODES,
		OVERLAY_LAYERS, POINT_LAYERS, QUAT_FILL, QUAT_LINES, RIVERS, SITES, baseStyle, basemapLayerIds, diamondImage, gaugeImage
	} from '#lib/components/map/mapStyle.ts';

	interface MapGeo {
		rivers: FeatureCollection;
	}

	const LABEL_ZOOM = 9;
	const FOCUS_ZOOM = 10;
	const PICK_RADIUS = 9;
	const FIT = { padding: 30, duration: 500 };
	/** The map's notice for each live layer it lost, in the order they are read out. */
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
	let gauges = $state.raw<FeatureCollection | null>(null);

	// A file beside the app, or any host allowing cross-origin range requests.
	const absolute = (raw: string | undefined) => {
		const v = raw?.trim();
		if (!v) return null;
		// Joined by hand: `new URL` would percent-encode the {fontstack} and {range} of a glyphs template.
		return /^https?:/.test(v) ? v : `${new URL('.', document.baseURI).href}${v}`;
	};
	const tilesUrl = absolute(import.meta.env.VITE_TILES_URL);
	const glyphs = absolute(import.meta.env.VITE_TILES_GLYPHS_URL);
	const style = baseStyle(tilesUrl, glyphs);

	const entries = $derived(searchEntries(app.nodes, app.sites));
	const liveNote = $derived(
		lostLive.length ? `${[LOST_QUATERNARIES, LOST_BASINS, LOST_GAUGES].filter((l) => lostLive.includes(l)).join(' ')} Everything else still works.` : ''
	);
	const labels = $derived([...labelPoints(app.nodes, app.sites, showNoFile), ...gaugeLabels(gauges, showGauges, showClosedGauges)]);

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
			const [lib, res] = await Promise.all([import('#lib/components/map/maplibre.ts'), fetch(asset('data/map.json'))]);
			if (!res.ok) throw new Error(`map.json: HTTP ${res.status}`);
			const geo = (await res.json()) as MapGeo;
			if (gone()) return;
			ml = lib;
			if (tilesUrl) await ml.usePmtiles();
			if (gone()) return;
			basins = basinBounds(app.nodes);
			allBounds = boundsOf(basins.map((b) => b.bounds));
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
				m.addSource('rivers', source(geo.rivers));
				m.addSource('basins', source(empty));
				m.addSource('nodes', source(nodeFeatures(app.nodes)));
				m.addSource('sites', source(siteFeatures(app.sites, app.nodes)));
				m.addSource('gauges', source(empty));
				const under = tilesUrl && glyphs ? FIRST_LABEL : undefined;
				for (const layer of OVERLAY_LAYERS) m.addLayer(layer, POINT_LAYERS.includes(layer.id) ? undefined : under);
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
		const live = (load: () => Promise<FeatureCollection>, lost: string, use: (fc: FeatureCollection) => void) =>
			load().then(
				(fc) => {
					if (map === m) use(fc);
				},
				() => {
					if (map === m) lostLive = [...lostLive, lost];
				}
			);
		const set = (id: string, data: FeatureCollection) => (m.getSource(id) as GeoJSONSource).setData(data);
		void live(loadQuaternaries, LOST_QUATERNARIES, (fc) => set('quaternaries', fc));
		void live(loadBasins, LOST_BASINS, (fc) => set('basins', fc));
		void live(loadGauges, LOST_GAUGES, (fc) => {
			set('gauges', fc);
			gauges = fc;
		});
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

	function onClick(e: { point: { x: number; y: number } }) {
		const f = pointsNear(e.point)[0];
		if (!f) return;
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
		else openPopup({ site: app.sites[f.properties.i] }, at);
	}

	function activate(id: string, at: LngLatLike) {
		app.select(id);
		const node = app.byId.get(id);
		if (node) openPopup({ node }, at);
	}

	function onHover(e: { point: { x: number; y: number }; lngLat: LngLatLike }) {
		const m = map!;
		const near = pointsNear(e.point);
		m.getCanvas().style.cursor = near.length ? 'pointer' : '';
		const text = near[0]?.properties.label ?? riverOrQuaternaryAt(e.point);
		if (text) tip?.setLngLat(e.lngLat).setText(text).addTo(m);
		else tip?.remove();
	}

	function riverOrQuaternaryAt(p: { x: number; y: number }): string {
		const m = map!;
		const rivers = showRivers ? m.queryRenderedFeatures([[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]], { layers: [RIVERS] }) : [];
		const name = rivers.find((f) => f.properties.n)?.properties.n;
		if (name) return name;
		return showQuaternaries ? (m.queryRenderedFeatures([p.x, p.y], { layers: [QUAT_FILL] })[0]?.properties.q ?? '') : '';
	}

	function openPopup(content: { node?: EwrNode; site?: EwrSite; gauge?: Gauge }, at: LngLatLike) {
		popup?.remove();
		const el = document.createElement('div');
		const body = mount(NodePopup, { target: el, props: content });
		// A popup requested while the map loaded opens later: by then focus may have moved on, and stays.
		const active = document.activeElement;
		const focusAfterOpen = !active || active === document.body || !!wrap?.contains(active);
		const opened = new ml.Popup({ maxWidth: '320px', offset: 10, focusAfterOpen }).setLngLat(at).setDOMContent(el).addTo(map!);
		opened.once('close', () => {
			void unmount(body);
			if (popup === opened) popup = null;
		});
		popup = opened;
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
		setVisible([RIVERS], showRivers);
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
		if (node && node.lon !== null && node.lat !== null) untrack(() => flyAndOpen({ node }, [node.lon!, node.lat!]));
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
			pendingSite = app.sites[entry.target.index];
		}
	}
</script>

<section class="wrap" aria-label="Map of EWR nodes and sites" bind:this={wrap}>
	<div class="map" bind:this={container}></div>
	<div class="bar">
		<select aria-label="Zoom to a basin" bind:value={basin} onchange={zoomToBasin}>
			<option value="">All basins</option>
			{#each basins as b (b.name)}
				<option value={b.name}>{b.name}</option>
			{/each}
		</select>
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
	</div>
	<MapLegend
		bind:quaternaries={showQuaternaries}
		bind:rivers={showRivers}
		bind:noFile={showNoFile}
		bind:gauges={showGauges}
		bind:closedGauges={showClosedGauges}
		bind:basemap={showBasemap}
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
		z-index: 3;
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
	.bar input {
		flex: 1;
		min-width: 120px;
		max-width: 240px;
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
