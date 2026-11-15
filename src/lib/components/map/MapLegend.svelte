<!--
	The key to the map's symbols, and the switches for its optional layers, behind a Legend button so
	a short map can put it away. The map decides whether it starts open (EwrMap.svelte).
-->
<script lang="ts">
	import {
		BASIN_BLACK, GAUGE_GREEN, NO_FILE_EDGE, NODE_BLUE, NODE_EDGE, QUAT_LINE, QUAT_TINT, RIVER_BLUE, SITE_EDGE, SITE_ORANGE, WMA_PURPLE
	} from '#lib/components/map/mapStyle.ts';

	let {
		quaternaries = $bindable(),
		rivers = $bindable(),
		noFile = $bindable(),
		gauges = $bindable(),
		closedGauges = $bindable(),
		basemap = $bindable(),
		hasNodes,
		hasBasemap,
		basemapFailed,
		open = $bindable(),
		el = $bindable(),
		ontoggle
	}: {
		quaternaries: boolean;
		rivers: boolean;
		noFile: boolean;
		gauges: boolean;
		closedGauges: boolean;
		basemap: boolean;
		/** A WMA with no EWR data has no nodes, sites or basins to explain. */
		hasNodes: boolean;
		hasBasemap: boolean;
		basemapFailed: boolean;
		open: boolean;
		/** The legend's box, which the map keeps its fits clear of. */
		el?: HTMLElement;
		/** Called when the viewer opens or closes it. */
		ontoggle: (open: boolean) => void;
	} = $props();

	const id = $props.id();
</script>

<div class="legend" bind:this={el}>
	<button
		type="button"
		class="toggle"
		aria-expanded={open}
		aria-controls="{id}-keys"
		onclick={() => {
			open = !open;
			ontoggle(open);
		}}
	>
		<svg width="10" height="10" aria-hidden="true"><path d={open ? 'M1 3l4 4 4-4' : 'M3 1l4 4-4 4'} fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
		Legend
	</button>
	<div id="{id}-keys" class="keys" hidden={!open}>
		{#if hasNodes}
			<div class="key">
				<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill={NODE_BLUE} stroke={NODE_EDGE} /></svg>
				EWR node
			</div>
			<div class="key">
				<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="#fff" stroke={NODE_BLUE} stroke-width="2" /></svg>
				EWR node, location approximate
			</div>
			<div class="key">
				<svg width="14" height="14" aria-hidden="true"><path d="M7 1 13 7 7 13 1 7Z" fill={SITE_ORANGE} stroke={SITE_EDGE} /></svg>
				EWR site
			</div>
			<div class="key">
				<svg width="14" height="14" aria-hidden="true"><path d="M1 7h12" stroke={BASIN_BLACK} stroke-width="3" /></svg>
				Basin boundary
			</div>
		{/if}
		<div class="key">
			<svg width="14" height="14" aria-hidden="true"><path d="M1 7h12" stroke={WMA_PURPLE} stroke-width="2.5" stroke-dasharray="4 2" /></svg>
			WMA boundary
		</div>
		<label>
			<input type="checkbox" bind:checked={quaternaries} />
			<svg width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" fill={QUAT_TINT} stroke={QUAT_LINE} /></svg>
			Quaternary catchments
		</label>
		<label>
			<input type="checkbox" bind:checked={rivers} />
			<svg width="14" height="14" aria-hidden="true"><path d="M1 10 5 5 9 9 13 4" fill="none" stroke={RIVER_BLUE} stroke-width="2" /></svg>
			Rivers
		</label>
		{#if hasNodes}
			<label>
				<input type="checkbox" bind:checked={noFile} />
				<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="3.5" fill="#fff" stroke={NO_FILE_EDGE} /></svg>
				Nodes with no EC file
			</label>
		{/if}
		<label>
			<input type="checkbox" bind:checked={gauges} />
			<svg width="14" height="14" aria-hidden="true"><path d="M7 2 13 12H1Z" fill={GAUGE_GREEN} /></svg>
			Flow gauges
		</label>
		<label>
			<input type="checkbox" bind:checked={closedGauges} />
			<svg width="14" height="14" aria-hidden="true"><path d="M7 2 13 12H1Z" fill="#fff" stroke={GAUGE_GREEN} stroke-width="1.5" /></svg>
			Closed flow gauges
		</label>
		{#if hasBasemap}
			<label class:off={basemapFailed}>
				<input type="checkbox" bind:checked={basemap} disabled={basemapFailed} />
				{basemapFailed ? 'Base map not available' : 'Base map'}
			</label>
		{/if}
	</div>
</div>

<style>
	.legend {
		position: absolute;
		left: 10px;
		bottom: 46px;
		z-index: 3;
		background: rgba(252, 252, 251, 0.95);
		border: 1px solid #dddcd5;
		border-radius: 6px;
		padding: 2px 10px 6px;
		line-height: 1.5;
		font-size: 12px;
		color: #0b0b0b;
	}
	.key,
	label {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: #0b0b0b;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 -10px -4px;
		padding: 4px 10px;
		min-height: 24px;
		border: 0;
		background: none;
		font: inherit;
		font-weight: 600;
		color: #0b0b0b;
		cursor: pointer;
	}
	.keys {
		margin-top: 4px;
	}
	.keys[hidden] {
		display: none;
	}
	.off {
		color: #6f6e69;
	}
	input {
		margin: 0 1px;
	}
	svg {
		flex: none;
	}
</style>
