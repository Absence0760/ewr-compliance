<script lang="ts">
	import EwrMap from '#lib/components/map/EwrMap.svelte';
	import CompliancePanel from '#lib/components/compliance/CompliancePanel.svelte';
	import { wmaOfBasin } from '#lib/components/map/wma.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const wma = $derived(data.wma);
	const hasNodes = $derived(app.nodes.some((n) => wmaOfBasin(n.basin)?.slug === wma.slug));
</script>

<section class="view split">
	<!-- A new map for each WMA: its sources, bounds and live layers are all the WMA's own. -->
	{#key wma.slug}
		<EwrMap {wma} />
	{/key}
	{#if hasNodes || app.gaugeView}
		<CompliancePanel />
	{:else}
		<aside class="panel" aria-label="Compliance">
			<h2>{wma.name}</h2>
			<p class="emptystate">
				No EWR nodes in this Water Management Area yet. Choose a flow gauge or a river on the map for its details,
				or pick another WMA.
			</p>
		</aside>
	{/if}
</section>

<style>
	h2 {
		margin: 0 0 4px;
		font-size: 18px;
	}
</style>
