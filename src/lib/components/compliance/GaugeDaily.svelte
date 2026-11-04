<script lang="ts">
	// A gauge's daily flow as measured, one month at a time. No EWR lines and no factor: those belong to a node.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { gaugeSeries } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { defaultMonth, loadedMonths, monthOf, rtRange, rtSeries, unitTitle } from './compare.ts';
	import DayTable from './DayTable.svelte';
	import MonthSelect from './MonthSelect.svelte';

	let { station }: { station: string } = $props();

	const flows = $derived(app.flows[station]);
	const s = $derived(flows ? gaugeSeries(flows) : null);
	const months = $derived(s ? loadedMonths(s.days) : []);
	let picked = $state('');
	const month = $derived(months.includes(picked) ? picked : s ? defaultMonth(s.days) : '');
	const days = $derived(s ? s.days.filter((d) => monthOf(d.t) === month) : []);
	const range = $derived(rtRange(days, month || '2000-01'));
	/** The month's 12-minute readings, drawn over the daily flow when asked for. */
	let showRaw = $state(false);
	const readings = $derived(s ? s.readings.filter((p) => p.v !== null && monthOf(p.t) === month) : []);
	const series = $derived(days.length ? rtSeries(null, days, showRaw && readings.length ? readings : null, range) : []);
</script>

{#if app.flowsError}
	<div class="notice error" role="alert">{app.flowsError}</div>
{/if}

{#if s}
	<div class="notice info">Daily flow as measured, m³/s. Missing days are not drawn, and a value with a quality code has its own colour.</div>
	<div class="controls">
		<MonthSelect {months} bind:value={() => month, (v) => (picked = v)} />
		{#if s.readings.length}
			<label class="check"><input type="checkbox" bind:checked={showRaw} /> Show 12-minute readings</label>
		{/if}
	</div>
	{#if showRaw && !readings.length}
		<p class="muted" role="status">No 12-minute readings in this month.</p>
	{/if}
	<LineChart title="Daily flow, {station}" axis="time" xRange={range} xLabel="Days" yLabel={unitTitle('cumec')} {series} />
	<DayTable {days} {month} />
{/if}
