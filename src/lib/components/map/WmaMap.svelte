<!--
	The national map: South Africa's Water Management Areas, each opening its own map. The list beside
	it (WmaList) is the keyboard route to the same places, and stands in when the live layer is down.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { GeoJSONSource, GeoJSONSourceSpecification, Map as MapLibreMap, Popup } from 'maplibre-gl';
	import { loadWmas } from '#lib/components/map/catchments.ts';
	import { CREDIT, FIRST_LABEL, WMA_PURPLE, baseStyle } from '#lib/components/map/mapStyle.ts';
	import { NATIONAL_BOUNDS } from '#lib/components/map/wma.ts';

	/** The slug of the WMA under the pointer or in focus in the list, highlighted on both. */
	let { hovered = $bindable(''), withData }: { hovered?: string; withData: Set<string> } = $props();

	const FILL = 'wma-fill';
	const LINE = 'wma-outline';
	const LOST = 'Water Management Areas could not be loaded from the DWS service. Choose one from the list.';

	let container: HTMLDivElement;
	let map: MapLibreMap | null = null;
	let tip: Popup | null = null;
	let ready = $state(false);
	let failure = $state('');

	const absolute = (raw: string | undefined) => {
		const v = raw?.trim();
		if (!v) return null;
		return /^https?:/.test(v) ? v : `${new URL('.', document.baseURI).href}${v}`;
	};
	const tilesUrl = absolute(import.meta.env.VITE_TILES_URL);
	const glyphs = absolute(import.meta.env.VITE_TILES_GLYPHS_URL);

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
			const ml = await import('#lib/components/map/maplibre.ts');
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
				loadWmas().then(
					(fc) => {
						if (map === m) (m.getSource('wmas') as GeoJSONSource).setData(fc);
					},
					() => {
						if (map === m) failure = LOST;
					}
				);
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
		// Lesotho and Eswatini have no slug, so nothing hovered must not match them.
		if (ready) map!.setPaintProperty(FILL, 'fill-opacity', h ? ['case', ['==', ['get', 'w'], h], 0.75, 0.45] : 0.45);
	});
</script>

<section class="wrap" aria-label="Map of Water Management Areas">
	<div class="map" bind:this={container}></div>
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
