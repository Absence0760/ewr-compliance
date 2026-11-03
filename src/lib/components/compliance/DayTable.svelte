<script lang="ts">
	// Each day of a month: the values behind the chart, with their quality codes.
	import { fmt } from '#lib/ewr/format.ts';
	import type { DayMean, FlowUnit } from '#lib/ewr/types.ts';
	import { dayRowsOf, monthName, unitName } from './compare.ts';
	import CopyTable from './CopyTable.svelte';

	let { days, month, unit = 'cumec' }: { days: DayMean[]; month: string; unit?: FlowUnit } = $props();

	const rows = $derived(dayRowsOf(days, month, unit));
	let table = $state<HTMLTableElement>();
</script>

<div class="tablehead">
	<h3>Daily flow, {monthName(month)}, {unitName(unit)}</h3>
	<CopyTable {table} />
</div>
<div class="tablewrap daytable">
	<table bind:this={table} aria-label="Daily flow, {monthName(month)}">
		<thead>
			<tr>
				<th>Date</th>
				<th class="n">Mean flow</th>
				<th class="n">Readings</th>
				<th class="n">Quality code</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.date)}
				<tr class:coded={r.coded}>
					<td>{r.date}</td>
					<td class="n">{fmt(r.flow)}</td>
					<td class="n">{r.readings || '–'}</td>
					<td class="n">{r.code || '–'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.daytable {
		max-height: 320px;
	}
	.coded td {
		color: #a01358;
		font-weight: 600;
	}
</style>
