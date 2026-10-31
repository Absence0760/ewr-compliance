<script lang="ts">
	// Instantaneous flow stays in m³/s here; an EWR volume has no meaning at a 12-minute step.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { timeReadout } from '#lib/components/charts/chart.ts';
	import { fmt } from '#lib/ewr/format.ts';
	import { dailyMeans } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { loadedMonths, monthName, monthOf, rtLatest, rtRange, rtRows, rtSeries, unitTitle } from './compare.ts';
	import CopyTable from './CopyTable.svelte';
	import FlowImport from './FlowImport.svelte';

	const EMPTY_RANGE: [number, number] = [0, 86400000];
	const r = app.rtView;
	const f = $derived(app.rt.flow);
	const allPoints = $derived(f?.points ?? []);
	const daily = $derived(dailyMeans(allPoints));
	const months = $derived(loadedMonths(daily));
	const inMonth = (t: number) => r.month === 'all' || monthOf(t) === r.month;
	const days = $derived(daily.filter((d) => inMonth(d.t)));
	const pts = $derived(allPoints.filter((p) => p.v !== null && inMonth(p.t)));
	const range = $derived(days.length ? rtRange(days, r.month) : EMPTY_RANGE);
	const series = $derived(days.length ? rtSeries(app.lines, days, r.showRaw ? pts : null, range) : []);
	const latest = $derived(rtLatest(app.lines, pts));
	const rows = $derived(app.lines && f ? rtRows(app.lines, daily) : null);
	const xLabel = $derived(r.month === 'all' ? 'Date' : 'Days');
	let table = $state<HTMLTableElement>();
</script>

<FlowImport want="instant" />

{#if f}
	<div class="controls">
		<label>Month
			<select bind:value={r.month}>
				<option value="all">All loaded</option>
				{#each months as m (m)}<option value={m}>{monthName(m)}</option>{/each}
			</select>
		</label>
		<label class="check"><input type="checkbox" bind:checked={r.showRaw} /> Show 12-minute readings</label>
	</div>
{/if}

{#if latest}
	<div class="stats">
		<div class="stat"><span>Latest reading, {timeReadout(latest.t)}</span><b>{fmt(latest.v)} m³/s</b></div>
		{#if app.lines}
			<div class="stat"><span>EWR for {latest.month}</span><b>{fmt(latest.ewr)} m³/s</b></div>
			<div class="stat"><span>Latest as % of EWR</span><b>{fmt(latest.pct, 0)}%</b></div>
		{/if}
	</div>
{/if}

<LineChart title="Real Time Comparison" axis="time" xRange={range} {xLabel} yLabel={unitTitle('cumec')} {series} />

{#if rows}
	<div class="tablehead">
		<h3>By month, m³/s</h3>
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
{/if}
