<script lang="ts">
	// A month pull-down, grouped by year: a gauge's daily record runs to hundreds of months.
	import { monthName, yearGroups } from './compare.ts';

	let { months, all = false, value = $bindable() }: { months: string[]; all?: boolean; value: string } = $props();
</script>

<label>Month
	<select bind:value>
		{#if all}<option value="all">All loaded</option>{/if}
		{#each yearGroups(months) as g (g.year)}
			<optgroup label={g.year}>
				{#each g.months as m (m)}<option value={m}>{monthName(m)}</option>{/each}
			</optgroup>
		{/each}
	</select>
</label>
