<!-- A gauge's monthly volumes as published, with its full-record means and the nodes it measures. -->
<script lang="ts">
	import { MONTHS, gaugeFlow, meanMonthly } from '#lib/ewr/parsers.ts';
	import { fmt } from '#lib/ewr/format.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { GaugeMonth } from '#lib/ewr/types.ts';
	import { gaugeName } from './compare.ts';
	import CopyTable from './CopyTable.svelte';
	import GaugeDaily from './GaugeDaily.svelte';

	let { station, name }: { station: string; name: string } = $props();

	const record = $derived(app.gaugeRecords.get(station));
	const means = $derived(record ? meanMonthly(gaugeFlow(record).records, 0, Infinity) : []);
	const linked = $derived(app.links.filter((l) => l.station === station));
	let table = $state<HTMLTableElement>();

	const cell = (c: GaugeMonth) => `${fmt(c.v)}${c.quality}${c.incomplete ? ' #' : ''}`;
</script>

<div class="nodehead">
	<h2>{station}</h2>
	<span class="muted">Flow gauge{name ? ` · ${name}` : ''}</span>
</div>

<div class="controls">
	<button type="button" onclick={() => (app.gaugeView = null)}>{app.selected ? `Back to ${app.selected.label}` : 'Close'}</button>
	{#each linked as l (l.node)}
		{#if l.node !== app.selectedId}
			<button type="button" onclick={() => app.select(l.node, { focus: true })}>Open {app.byId.get(l.node)?.label ?? l.node}</button>
		{/if}
	{/each}
</div>

{#if linked.length}
	<div class="notice info">
		{#each linked as l (l.node)}
			Measured flow for {app.byId.get(l.node)?.label ?? l.node}: {gaugeName(station, l.factor)}.{' '}
		{/each}
	</div>
{/if}

{#if app.flowStations.has(station)}
	<GaugeDaily {station} />
{/if}

{#if record}
	<div class="notice info">Monthly volumes in Mm³, as supplied. A month marked # is incomplete or missing, and is left out of the means. A month marked + is a patched value, and counts.</div>

	<div class="tablehead">
		<h3>Monthly volumes, Mm³</h3>
		<CopyTable {table} />
	</div>
	<div class="tablewrap">
		<table bind:this={table} aria-label="Monthly volumes of {station} by hydrological year">
			<thead>
				<tr>
					<th>Year</th>
					{#each MONTHS as m (m)}<th class="n">{m}</th>{/each}
					<th class="n">Total</th>
				</tr>
			</thead>
			<tbody>
				{#each record.years as y (y.label)}
					<tr>
						<th scope="row">{y.label}</th>
						{#each y.months as c, i (i)}
							<td class="n" class:flagged={c.incomplete} class:patched={c.quality === '+'}>{cell(c)}</td>
						{/each}
						<td class="n" class:flagged={y.total.incomplete}>{cell(y.total)}</td>
					</tr>
				{/each}
			</tbody>
			<tfoot>
				<tr>
					<th scope="row">Mean</th>
					{#each means as m, i (i)}<td class="n">{fmt(m.mean)}</td>{/each}
					<td></td>
				</tr>
				<tr>
					<th scope="row">Years used</th>
					{#each means as m, i (i)}<td class="n">{m.n}</td>{/each}
					<td></td>
				</tr>
			</tfoot>
		</table>
	</div>
{/if}

<style>
	th[scope='row'] {
		text-align: left;
		white-space: nowrap;
	}
	.flagged {
		color: var(--ink-2);
		background: var(--surface-2);
	}
	.patched {
		color: #a01358;
		font-weight: 600;
	}
	tfoot th,
	tfoot td {
		font-weight: 650;
	}
</style>
