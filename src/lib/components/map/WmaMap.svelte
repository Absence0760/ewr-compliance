<!--
	The national map: South Africa's Water Management Areas, each opening its own map. The list beside
	it (WmaList) is the keyboard route to the same places, and stands in when the live layer is down.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { asset, resolve } from '$app/paths';
	import type { GeoJSONSource, GeoJSONSourceSpecification, Map as MapLibreMap, Marker, Popup } from 'maplibre-gl';
	import { loadWmas } from '#lib/components/map/catchments.ts';
	import { CREDIT, FIRST_LABEL, WMA_PURPLE, baseStyle, tileUrl } from '#lib/components/map/mapStyle.ts';
	import { NATIONAL_BOUNDS, NEIGHBOURS, WMAS } from '#lib/components/map/wma.ts';

	/** The slug of the WMA under the pointer or in focus in the list, highlighted on both. */
	let { hovered = $bindable(''), withData }: { hovered?: string; withData: Set<string> } = $props();

	const FILL = 'wma-fill';
	const LINE = 'wma-outline';
	const LOST = 'Water Management Areas could not be loaded from the DWS service. Choose one from the list.';

	let container: HTMLDivElement;
	let map: MapLibreMap | null = null;
	let tip: Popup | null = null;
	/** A name on each WMA, as DOM markers, so they need no base map fonts. By slug. */
	const labels = new Map<string, Marker>();
	let ready = $state(false);
	let failure = $state('');
	/** Whether the live WMA layer has answered, loaded or lost. */
	let answered = $state(false);

	// The app's root as a full URL: a setting that is a path is beside the app, wherever the page is.
	const root = new URL(asset('' as never), document.baseURI).href;
	const tilesUrl = tileUrl(import.meta.env.VITE_TILES_URL, root);
	const glyphs = tileUrl(import.meta.env.VITE_TILES_GLYPHS_URL, root);

	onMount(() => {
		let gone = false;
		void start(() => gone);
		return () => {
			gone = true;
			ready = false;
			labels.clear();
			map?.remove();
			map = null;
		};
	});

	async function start(gone: () => boolean) {
		try {
			const ml = await import('#lib/components/map/maplibre.ts');
			const nameLabel = (text: string, at: number[], className: string) => {
				const el = document.createElement('div');
				el.className = className;
				el.textContent = text;
				return new ml.Marker({ element: el }).setLngLat(at as [number, number]).addTo(map!);
			};
			const nameLabels = () => {
				for (const w of WMAS) labels.set(w.slug, nameLabel(w.name, w.label, 'wma-label'));
				// Lesotho and Eswatini are named in grey, like their fill: they cannot be chosen.
				for (const c of NEIGHBOURS) nameLabel(c.name, c.label, 'wma-label other');
			};
			if (tilesUrl) await ml.usePmtiles();
			if (gone()) return;
			const m = new ml.MapLibreMap({
				container,
				style: baseStyle(tilesUrl, glyphs),
				bounds: NATIONAL_BOUNDS,
				fitBoundsOptions: { padding: 20 },
				dragRotate: false,
				pitchWithRotate: false,
				attributionControl: { compact: false, customAttribution: CREDIT }
			});
			map = m;
			m.touchZoomRotate.disableRotation();
			m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
			tip = new ml.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 12, className: 'ewr-tip' });
			m.on('load', () => {
				m.addSource('wmas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'w' } as GeoJSONSourceSpecification);
				const under = tilesUrl && glyphs ? FIRST_LABEL : undefined;
				m.addLayer({
					id: FILL,
					type: 'fill',
					source: 'wmas',
					paint: {
						// A WMA with EWR data is tinted, one without is pale, and Lesotho and Eswatini are grey.
						'fill-color': ['case', ['==', ['get', 'w'], ''], '#c9c8c2', ['in', ['get', 'w'], ['literal', [...withData]]], '#8f74c0', '#d9cfeb'],
						'fill-opacity': 0.45
					}
				}, under);
				m.addLayer({ id: LINE, type: 'line', source: 'wmas', paint: { 'line-color': WMA_PURPLE, 'line-width': 1.5 } }, under);
				loadWmas()
					.then(
						(fc) => {
							if (map !== m) return;
							(m.getSource('wmas') as GeoJSONSource).setData(fc);
							// Named only once there are outlines to name: without them the list stands in.
							nameLabels();
						},
						() => {
							if (map === m) failure = LOST;
						}
					)
					.finally(() => {
						if (map === m) answered = true;
					});
				m.on('mousemove', FILL, (e) => {
					const f = e.features?.[0];
					const w = (f?.properties.w as string) ?? '';
					m.getCanvas().style.cursor = w ? 'pointer' : '';
					hovered = w;
					if (f) tip?.setLngLat(e.lngLat).setText(f.properties.name).addTo(m);
				});
				m.on('mouseleave', FILL, () => {
					m.getCanvas().style.cursor = '';
					hovered = '';
					tip?.remove();
				});
				m.on('click', FILL, (e) => {
					const w = e.features?.[0]?.properties.w as string | undefined;
					if (w) void goto(resolve(`wma/${w}/` as '/'));
				});
				ready = true;
			});
		} catch (e) {
			failure = `The map could not be drawn: ${(e as Error).message}. Choose a WMA from the list.`;
		}
	}

	$effect(() => {
		const h = hovered;
		for (const [slug, marker] of labels) marker.getElement().classList.toggle('on', slug === h);
		// Lesotho and Eswatini have no slug, so nothing hovered must not match them.
		if (ready) map!.setPaintProperty(FILL, 'fill-opacity', h ? ['case', ['==', ['get', 'w'], h], 0.75, 0.45] : 0.45);
	});
</script>

<section class="wrap" aria-label="Map of Water Management Areas">
	<!-- Busy until the map is drawn and the live WMA layer has answered, loaded or lost, or it could not start. -->
	<div class="map" bind:this={container} aria-busy={!failure && !(ready && answered)}></div>
	{#if failure}
		<p class="failure" role="alert">{failure}</p>
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
	.wrap :global(.wma-label) {
		z-index: 1;
		pointer-events: none;
		padding: 1px 5px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.82);
		color: #2f2152;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
	}
	.wrap :global(.wma-label.other) {
		background: rgba(255, 255, 255, 0.7);
		color: #52514e;
		font-weight: 400;
		font-style: italic;
	}
	.wrap :global(.wma-label.on) {
		background: #fff;
		box-shadow: 0 0 0 1.5px #5b3a8c;
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
