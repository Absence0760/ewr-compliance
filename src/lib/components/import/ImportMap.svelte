<!--
	The import's map: the chosen WMA's outline and rivers, and the KML's nodes, those with data filled
	and those with none hollow, so a node to attach files to stands out. Clicking a node opens its
	panel, as its button in the list does; the list is the keyboard route. MapLibre loads when this
	mounts (maplibre.ts), as on a WMA's own map.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { asset } from '$app/paths';
	import type { FeatureCollection } from 'geojson';
	import type { GeoJSONSource, GeoJSONSourceSpecification, Map as MapLibreMap, Popup } from 'maplibre-gl';
	import type { EwrNode } from '#lib/ewr/types.ts';
	import { siteFetch } from '#lib/users/siteFetch.ts';
	import { boundsOf } from '#lib/components/map/mapData.ts';
	import { CREDIT, MINOR_RIVERS, NODE_BLUE, NODE_EDGE, NO_FILE_EDGE, OVERLAY_LAYERS, RIVERS, WMA_LINE, WMA_PURPLE, baseStyle, tileUrl } from '#lib/components/map/mapStyle.ts';
	import type { Wma } from '#lib/components/map/wma.ts';

	let {
		wma,
		nodes,
		boundary,
		boundaryState,
		selected,
		onselect
	}: {
		wma: Wma;
		nodes: EwrNode[];
		boundary: FeatureCollection | null;
		boundaryState: 'none' | 'loading' | 'loaded' | 'lost';
		selected: string | null;
		onselect: (id: string) => void;
	} = $props();

	const NODES = 'import-nodes';
	const SELECTED = 'import-selected';
	const PICK_RADIUS = 9;
	const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

	let container: HTMLDivElement;
	let map: MapLibreMap | null = null;
	let tip: Popup | null = null;
	let ready = $state(false);
	let riversAnswered = $state(false);
	let riversLost = $state(false);
	/** Whether the map has drawn the nodes it was last given. */
	let drawn = $state(false);
	let failure = $state('');

	const root = new URL(asset('' as never), document.baseURI).href;
	const tilesUrl = tileUrl(import.meta.env.VITE_TILES_URL, root);
	const glyphs = tileUrl(import.meta.env.VITE_TILES_GLYPHS_URL, root);

	/** One point per node with a location: `data` picks filled or hollow. */
	const points = $derived<FeatureCollection>({
		type: 'FeatureCollection',
		features: nodes
			.filter((n) => n.lon !== null && n.lat !== null)
			.map((n) => ({
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [n.lon!, n.lat!] },
				properties: { id: n.id, label: n.label, data: n.files.length > 0 }
			}))
	});

	onMount(() => {
		let gone = false;
		void start(() => gone);
		return () => {
			gone = true;
			ready = false;
			map?.remove();
			map = null;
		};
	});

	async function start(gone: () => boolean) {
		try {
			const riversFile = `geo/rivers-${wma.slug}.json` as Parameters<typeof asset>[0];
			const ml = await import('#lib/components/map/maplibre.ts');
			if (tilesUrl) await ml.usePmtiles();
			if (gone()) return;
			const m = new ml.MapLibreMap({
				container,
				style: baseStyle(tilesUrl, glyphs),
				bounds: wma.bounds,
				fitBoundsOptions: { padding: 30 },
				dragRotate: false,
				pitchWithRotate: false,
				attributionControl: { compact: false, customAttribution: CREDIT }
			});
			map = m;
			m.touchZoomRotate.disableRotation();
			m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
			tip = new ml.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 12, className: 'ewr-tip' });
			m.on('load', () => {
				const source = (data: unknown) => ({ type: 'geojson', data }) as GeoJSONSourceSpecification;
				m.addSource('rivers', source(EMPTY));
				m.addSource('wma', source(boundary ?? EMPTY));
				m.addSource('nodes', source(points));
				for (const layer of OVERLAY_LAYERS.filter((l) => [MINOR_RIVERS, RIVERS, WMA_LINE].includes(l.id))) m.addLayer(layer);
				m.addLayer({
					id: SELECTED,
					type: 'circle',
					source: 'nodes',
					filter: ['==', ['get', 'id'], ''],
					paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#0b0b0b', 'circle-stroke-width': 2 }
				});
				m.addLayer({
					id: NODES,
					type: 'circle',
					source: 'nodes',
					paint: {
						'circle-radius': 5.5,
						'circle-color': ['case', ['get', 'data'], NODE_BLUE, '#ffffff'],
						'circle-stroke-color': ['case', ['get', 'data'], NODE_EDGE, NO_FILE_EDGE],
						'circle-stroke-width': ['case', ['get', 'data'], 1, 2]
					}
				});
				// The rivers are context only: a map without them still does its job.
				siteFetch(asset(riversFile))
					.then((res) => {
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						return res.json() as Promise<FeatureCollection>;
					})
					.then(
						(fc) => {
							if (map === m) (m.getSource('rivers') as GeoJSONSource).setData(fc);
						},
						() => {
							if (map === m) riversLost = true;
						}
					)
					.finally(() => {
						if (map === m) riversAnswered = true;
					});
				m.on('click', (e) => {
					const f = near(e.point)[0];
					if (f) onselect(String(f.properties.id));
				});
				m.on('mousemove', (e) => {
					const f = near(e.point)[0];
					m.getCanvas().style.cursor = f ? 'pointer' : '';
					if (f) tip?.setLngLat(e.lngLat).setText(`${f.properties.label}${f.properties.data ? '' : ' (no data)'}`).addTo(m);
					else tip?.remove();
				});
				m.on('mouseout', () => tip?.remove());
				ready = true;
			});
		} catch (e) {
			failure = `The map could not be drawn: ${(e as Error).message}. The list beside it has every node.`;
		}
	}

	function near(p: { x: number; y: number }) {
		const m = map!;
		const away = (f: { geometry: unknown }) => {
			const q = m.project((f.geometry as { coordinates: [number, number] }).coordinates);
			return Math.hypot(q.x - p.x, q.y - p.y);
		};
		return m
			.queryRenderedFeatures([[p.x - PICK_RADIUS, p.y - PICK_RADIUS], [p.x + PICK_RADIUS, p.y + PICK_RADIUS]], { layers: [NODES] })
			.sort((a, b) => away(a) - away(b));
	}

	// The nodes, and the view on them when they change.
	$effect(() => {
		const fc = points;
		if (!ready) return;
		const m = map!;
		drawn = false;
		(m.getSource('nodes') as GeoJSONSource).setData(fc);
		m.once('idle', () => {
			if (map === m) drawn = true;
		});
		const coords = fc.features.map((f) => (f.geometry as { coordinates: number[] }).coordinates);
		m.fitBounds(coords.length ? boundsOf(coords) : wma.bounds, { padding: 40, maxZoom: 10, duration: 0 });
	});

	$effect(() => {
		const b = boundary;
		if (ready) (map!.getSource('wma') as GeoJSONSource).setData(b ?? EMPTY);
	});

	$effect(() => {
		const id = selected ?? '';
		if (ready) map!.setFilter(SELECTED, ['==', ['get', 'id'], id]);
	});

	/** Drawn, with the nodes it was last given, and every live layer answered: what the specs wait on. */
	const settled = $derived(!!failure || (ready && drawn && riversAnswered && boundaryState !== 'loading'));
</script>

<section class="wrap" aria-label="Map of imported nodes">
	<div class="map" bind:this={container} aria-busy={!settled}></div>
	<div class="legend">
		<div class="key">
			<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill={NODE_BLUE} stroke={NODE_EDGE} /></svg>
			Node with data
		</div>
		<div class="key">
			<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="#fff" stroke={NO_FILE_EDGE} stroke-width="2" /></svg>
			Node with no data
		</div>
		<div class="key">
			<svg width="14" height="14" aria-hidden="true"><path d="M1 7h12" stroke={WMA_PURPLE} stroke-width="2.5" stroke-dasharray="4 2" /></svg>
			WMA boundary
		</div>
	</div>
	{#if !nodes.length && !failure}
		<p class="empty" role="status">Load a node KML to see its nodes on the map of {wma.name}.</p>
	{/if}
	{#if failure || riversLost}
		<p class="failure" role="alert">{failure || 'Rivers could not be loaded. The nodes are still shown.'}</p>
	{/if}
</section>

<style>
	.wrap {
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		border-right: 1px solid var(--line);
	}
	.map {
		position: absolute;
		inset: 0;
		background: #eef0ee;
		font-family: inherit;
	}
	.legend {
		position: absolute;
		left: 10px;
		bottom: 46px;
		z-index: 3;
		background: rgba(252, 252, 251, 0.95);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
		line-height: 1.5;
	}
	.key {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.empty {
		position: absolute;
		top: 10px;
		left: 48px;
		right: 10px;
		z-index: 3;
		margin: 0;
		padding: 6px 10px;
		background: rgba(252, 252, 251, 0.95);
		border-left: 3px solid var(--accent);
		font-size: 13px;
	}
	.failure {
		position: absolute;
		inset: 60px 20px auto;
		z-index: 3;
		margin: 0;
		padding: 8px 10px;
		background: #fbeceb;
		border-left: 3px solid var(--critical);
		font-size: 13px;
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
			border-bottom: 1px solid var(--line);
		}
	}
</style>
