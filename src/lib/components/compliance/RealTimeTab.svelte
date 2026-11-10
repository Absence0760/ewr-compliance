<script lang="ts">
	// 12-minute readings and the daily means worked from them. A gauge's daily record is history, and is in the
	// Historical Comparison. Flow is measured and compared in m³/s; the unit switch shows it in the EWR's units.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { timeReadout } from '#lib/components/charts/chart.ts';
	import { fmt } from '#lib/ewr/format.ts';
	import { dwsStatus } from '#lib/ewr/dwsStore.ts';
	import { dailyMeans } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { countOf, defaultMonth, gaugeName, loadedMonths, monthOf, rtLatest, rtRange, rtRows, rtSeries, unitName, unitTitle } from './compare.ts';
	import DailyMonthTable from './DailyMonthTable.svelte';
	import DayTable from './DayTable.svelte';
	import FlowImport from './FlowImport.svelte';
	import GaugeFactor from './GaugeFactor.svelte';
	import MonthSelect from './MonthSelect.svelte';

	const EMPTY_RANGE: [number, number] = [0, 86400000];
	const r = app.rtView;
	const dws = $derived(r.source === 'dws');
	/** A linked gauge's readings, or the DWS store's copy of them, put together and factored the same way. */
	const gauge = $derived(r.source === 'gauge' ? app.gaugeRt : dws ? app.dwsRt : null);
	const link = $derived(r.source === 'gauge' || dws ? app.link : null);
	const stored = $derived(dws && link && app.dwsStation ? dwsStatus(link.station, app.dwsStation) : null);
	const f = $derived(r.source === 'sheet' || r.source === 'text' ? app.rt.flow : null);
	const allPoints = $derived(gauge ? gauge.readings : (f?.points ?? []));
	const daily = $derived(gauge ? gauge.days : dailyMeans(allPoints));
	const months = $derived(loadedMonths(daily));
	/** A gauge's readings are read a month at a time, so they have no whole-record view. */
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
</script>

<FlowImport want="instant" />

{#if r.source === 'gauge' && app.flowsError}
	<div class="notice error" role="alert">{app.flowsError}</div>
{:else if dws && app.dwsError}
	<div class="notice error" role="alert">{app.dwsError}</div>
{/if}

{#if stored}
	<div class="notice {stored.stale ? '' : 'info'}" role="status"><b>DWS store, {link?.station}.</b> {stored.text}</div>
{/if}

{#if link && gauge}
	<div class="notice info" role="status">
		<b>{link.station}{dws ? ', from the DWS store' : ''}.</b>
		{#if allPoints.length}
			{countOf(allPoints.length, 'reading')} over {countOf(daily.length, 'day')}, averaged to a daily mean flow.
		{:else}
			No 12-minute readings are held for this gauge. DWS publishes them for about the last month only.
		{/if}
		The daily flow record is under Daily flow in the Historical Comparison.
		<button type="button" onclick={() => app.showHist('daily')}>Show daily flow</button>
		{#if !dws}<button type="button" onclick={() => app.showGauge(link.station)}>View gauge record</button>{/if}
	</div>
	<GaugeFactor {link} />
{/if}

{#if (f || gauge) && months.length}
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

{#if gauge && month !== 'all' && days.length}
	<DayTable {days} {month} unit={app.unit} />
{/if}

{#if rows?.length}
	<DailyMonthTable {rows} unit={app.unit} />
{/if}
