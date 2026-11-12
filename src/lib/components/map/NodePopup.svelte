<!-- The popup for a node, a site with no linked node, a flow gauge or a river. EwrMap mounts it into a MapLibre popup. -->
<script module lang="ts">
	/** A reach of the DWS 1:500 000 rivers: its name, Strahler order and flow class. */
	export interface River {
		name: string;
		order: number;
		flow: string;
	}

	const FLOW: Record<string, string> = { Perennial: 'Perennial', NonPerennial: 'Non-perennial', Dry: 'Dry' };
</script>

<script lang="ts">
	import { app } from '#lib/state/app.svelte.ts';
	import { session } from '#lib/state/session.svelte.ts';
	import type { EwrNode, EwrSite } from '#lib/ewr/types.ts';
	import type { Gauge } from '#lib/components/map/catchments.ts';
	import { fileInUse, fileOption, infoRows } from '#lib/components/map/mapData.ts';

	let {
		node = null, site = null, gauge = null, river = null
	}: { node?: EwrNode | null; site?: EwrSite | null; gauge?: Gauge | null; river?: River | null } = $props();

	const view = $derived(node ? app.viewOf(node) : null);
	const files = $derived(node ? app.filesOf(node) : []);
	const inUse = $derived(view ? fileInUse(view, files) : undefined);
	let chosen = $derived(inUse ?? files[0]?.name ?? '');
	const link = $derived(node ? app.linkOf(node.id) : null);
	const info = $derived(node ? infoRows(app.infoOf(node.id)) : []);
	const linked = $derived(gauge ? app.links.filter((l) => l.station === gauge.station).map((l) => app.byId.get(l.node)?.label ?? l.node) : []);
</script>

<div class="pop">
	{#if node}
		<h3>{node.label}</h3>
		{#if app.isUploaded(node.id)}
			<div class="row added">Added on the site</div>
		{/if}
		{#if node.sites.length}
			<div class="row">EWR site: {node.sites.map((s) => s.label).join(', ')}</div>
		{/if}
		<div class="row">
			{node.river || 'River not named'}, {node.quat}{node.approx ? ' (location approximate)' : ''}
		</div>
		<div class="row">
			PES {node.pes || '–'}, REC {node.rec || '–'}, TEC {node.tec || '–'}, in use <b>{view?.ec || 'none'}</b>
		</div>
		{#if link}
			<div class="row">Measured at gauge {link.station}</div>
		{/if}
		{#each info as r (r.label)}
			<div class="row">{r.label}: {r.value}</div>
		{/each}
		{#if files.length}
			<label>
				View a file
				<select bind:value={chosen}>
					{#each files as f}
						<option value={f.name}>{fileOption(f)}</option>
					{/each}
				</select>
			</label>
			<button type="button" onclick={() => app.openFile(node.id, chosen)}>Open file</button>
		{:else}
			<div class="row">No files supplied.</div>
		{/if}
		{#if session.me?.admin}
			<button type="button" class="delete" onclick={() => app.askDelete(node.id)}>Delete node…</button>
		{/if}
	{:else if site}
		<h3>{site.label}</h3>
		<div class="row">EWR site, {site.basin}</div>
		<div class="row">{site.river ? `${site.river}. ` : ''}No EWR files are linked.</div>
	{:else if river}
		<h3>{river.name || 'River not named'}</h3>
		<div class="row">{[FLOW[river.flow], `Strahler order ${river.order}`].filter(Boolean).join(', ')}</div>
		<div class="row muted">DWS 1:500 000 rivers</div>
	{:else if gauge}
		<h3>{gauge.station}</h3>
		<div class="row">{gauge.name}</div>
		<div class="row">Flow gauge{gauge.quat ? `, ${gauge.quat}` : ''}{gauge.closed ? ', closed' : ''}</div>
		{#if linked.length}
			<div class="row">Measured flow for {linked.join(', ')}</div>
		{/if}
	{/if}
</div>

<style>
	.pop {
		font-size: 14px;
		min-width: 210px;
		color: #0b0b0b;
	}
	h3 {
		margin: 0 16px 2px 0;
		font-size: 14px;
	}
	.row {
		margin: 3px 0;
		color: #52514e;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 12px;
		color: #52514e;
	}
	.added {
		font-size: 12px;
		font-style: italic;
	}
	.delete {
		display: block;
		margin-top: 8px;
		color: var(--critical);
	}
	select {
		width: 100%;
		margin: 4px 0;
	}
</style>
