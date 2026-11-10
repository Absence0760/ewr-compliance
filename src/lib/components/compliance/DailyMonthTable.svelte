<script lang="ts">
	// Daily flow by month against the EWR: under the Historical Comparison's daily record and the Real Time Comparison's readings.
	import { fmt } from '#lib/ewr/format.ts';
	import type { FlowUnit } from '#lib/ewr/types.ts';
	import { unitName, type RtRow } from './compare.ts';
	import CopyTable from './CopyTable.svelte';

	let { rows, unit }: { rows: RtRow[]; unit: FlowUnit } = $props();

	let table = $state<HTMLTableElement>();
</script>

<div class="tablehead">
	<h3>By month, {unitName(unit)}</h3>
	<CopyTable {table} />
</div>
<div class="tablewrap">
	<table bind:this={table}>
		<thead>
			<tr>
				<th>Month</th>
				<th class="n">Days of data</th>
				<th class="n">Mean of daily flow</th>
				<th class="n">EWR Monthly Requirement</th>
				<th class="n">Urgent action required</th>
				<th class="n">Drought EWR</th>
				<th class="n">Days ≥ EWR</th>
				<th class="n">Days ≥ Drought</th>
				<th>Status of mean</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.label)}
				<tr>
					<td>{row.label}</td>
					<td class="n">{row.days}</td>
					<td class="n">{fmt(row.mean)}</td>
					<td class="n">{fmt(row.ewr)}</td>
					<td class="n">{fmt(row.urgent)}</td>
					<td class="n">{fmt(row.drought)}</td>
					<td class="n">{row.daysEwr}</td>
					<td class="n">{row.daysDrought}</td>
					<td><span class="status {row.status.key}">{row.status.label}</span></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
