<!-- The key to the map's symbols, and the switches for its optional layers. -->
<script lang="ts">
	import {
		BASIN_BLACK, GAUGE_GREEN, NO_FILE_EDGE, NODE_BLUE, NODE_EDGE, QUAT_LINE, QUAT_TINT, RIVER_BLUE, SITE_EDGE, SITE_ORANGE
	} from '#lib/components/map/mapStyle.ts';

	let {
		quaternaries = $bindable(),
		rivers = $bindable(),
		noFile = $bindable(),
		gauges = $bindable(),
		closedGauges = $bindable(),
		basemap = $bindable(),
		hasBasemap,
		basemapFailed
	}: {
		quaternaries: boolean;
		rivers: boolean;
		noFile: boolean;
		gauges: boolean;
		closedGauges: boolean;
		basemap: boolean;
		hasBasemap: boolean;
		basemapFailed: boolean;
	} = $props();
</script>

<div class="legend">
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
	<label>
		<input type="checkbox" bind:checked={noFile} />
		<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="3.5" fill="#fff" stroke={NO_FILE_EDGE} /></svg>
		Nodes with no EC file
	</label>
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

<style>
	.legend {
		position: absolute;
		left: 10px;
		bottom: 46px;
		z-index: 3;
		background: rgba(252, 252, 251, 0.95);
		border: 1px solid #dddcd5;
		border-radius: 6px;
		padding: 6px 10px;
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
