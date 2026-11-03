<script lang="ts">
	// Flow is measured and compared in m³/s. The unit switch shows all of it in the EWR's units.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { timeReadout } from '#lib/components/charts/chart.ts';
	import { fmt } from '#lib/ewr/format.ts';
	import { dailyMeans, isCoded } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { countOf, defaultMonth, gaugeName, loadedMonths, monthOf, rtLatest, rtRange, rtRows, rtSeries, unitName, unitTitle } from './compare.ts';
	import CopyTable from './CopyTable.svelte';
	import DayTable from './DayTable.svelte';
	import FlowImport from './FlowImport.svelte';
	import GaugeFactor from './GaugeFactor.svelte';
	import MonthSelect from './MonthSelect.svelte';

	const EMPTY_RANGE: [number, number] = [0, 86400000];
	const r = app.rtView;
	const gauge = $derived(r.source === 'gauge' ? app.gaugeRt : null);
	const link = $derived(r.source === 'gauge' ? app.link : null);
	const f = $derived(gauge ? null : app.rt.flow);
	const allPoints = $derived(gauge ? gauge.readings : (f?.points ?? []));
	const daily = $derived(gauge ? gauge.days : dailyMeans(allPoints));
	const months = $derived(loadedMonths(daily));
	/** A gauge's record is read a month at a time, so it has no whole-record view. */
	const month = $derived(gauge && !months.includes(r.month) ? defaultMonth(daily) : r.month);
	const inMonth = (t: number) => month === 'all' || monthOf(t) === month;
	const days = $derived(daily.filter((d) => inMonth(d.t)));
	const pts = $derived(allPoints.filter((p) => p.v !== null && inMonth(p.t)));
	const range = $derived(days.length ? rtRange(days, month) : EMPTY_RANGE);
	const label = $derived(link ? `Daily mean flow, ${gaugeName(link.station, app.factor)}` : undefined);
	const series = $derived(days.length ? rtSeries(app.lines, days, r.showRaw ? pts : null, range, label, app.unit) : []);
	const latest = $derived(rtLatest(app.lines, pts, app.unit));
	const u = $derived(unitName(app.unit));
	const rows = $derived(app.lines && (f || gauge) ? rtRows(app.lines, gauge ? days : daily, app.unit) : null);
	const xLabel = $derived(month === 'all' ? 'Date' : 'Days');
	const codedDays = $derived(daily.filter((d) => isCoded(d.code)).length);
	let table = $state<HTMLTableElement>();
</script>

<FlowImport want="instant" />

{#if r.source === 'gauge' && app.flowsError}
	<div class="notice error" role="alert">{app.flowsError}</div>
{/if}

{#if link && gauge}
	<div class="notice info" role="status">
		<b>{link.station}.</b> {countOf(daily.length, 'day')} of flow in {countOf(months.length, 'month')}. {countOf(codedDays, 'day')} with a quality code drawn in their own colour, and {countOf(gauge.missing, 'missing day')} not drawn.
		<button type="button" onclick={() => app.showGauge(link.station)}>View gauge record</button>
	</div>
	<GaugeFactor {link} />
{/if}

{#if f || gauge}
	<div class="controls">
		<MonthSelect {months} all={!gauge} bind:value={() => month, (v) => (r.month = v)} />
		<label class="check"><input type="checkbox" bind:checked={r.showRaw} /> Show 12-minute readings</label>
	</div>
{/if}

{#if latest}
	<div class="stats">
		<div class="stat"><span>Latest reading, {timeReadout(latest.t)}</span><b>{fmt(latest.v)} {u}</b></div>
		{#if app.lines}
			<div class="stat"><span>EWR for {latest.month}</span><b>{fmt(latest.ewr)} {u}</b></div>
			<div class="stat"><span>Latest as % of EWR</span><b>{fmt(latest.pct, 0)}%</b></div>
		{/if}
	</div>
{/if}

<LineChart title="Real Time Comparison" axis="time" xRange={range} {xLabel} yLabel={unitTitle(app.unit)} {series} />

{#if app.unit === 'mm3' && (f || gauge)}
	<p class="muted">In Mm³, each day is the month's volume at that day's flow, so it reads against the monthly EWR.</p>
{/if}

{#if gauge && month !== 'all'}
	<DayTable {days} {month} unit={app.unit} />
{/if}

{#if rows}
	<div class="tablehead">
		<h3>By month, {u}</h3>
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
