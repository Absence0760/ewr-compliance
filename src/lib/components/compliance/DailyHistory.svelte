<script lang="ts">
	// The Historical Comparison's daily view: a gauge's daily record, the DWS store's, or a daily file, a month at a
	// time against the EWR. Flow is measured and compared in m³/s; the unit switch shows it in the EWR's units.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { dwsStatus } from '#lib/ewr/dwsStore.ts';
	import { dailyMeans, isCoded } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { countOf, defaultMonth, gaugeName, loadedMonths, monthOf, rtRange, rtRows, rtSeries, unitTitle } from './compare.ts';
	import DailyMonthTable from './DailyMonthTable.svelte';
	import DayTable from './DayTable.svelte';
	import FlowImport from './FlowImport.svelte';
	import GaugeFactor from './GaugeFactor.svelte';
	import MonthSelect from './MonthSelect.svelte';

	const EMPTY_RANGE: [number, number] = [0, 86400000];
	const d = app.dayView;
	const dws = $derived(d.source === 'dws');
	const gauge = $derived(d.source === 'gauge' ? app.gaugeDay : dws ? app.dwsDay : null);
	const link = $derived(d.source === 'gauge' || dws ? app.link : null);
	const stored = $derived(dws && link && app.dwsStation ? dwsStatus(link.station, app.dwsStation) : null);
	const f = $derived(d.source === 'sheet' || d.source === 'text' ? app.day.flow : null);
	const daily = $derived(gauge ? gauge.days : dailyMeans(f?.points ?? []));
	const months = $derived(loadedMonths(daily));
	/** A gauge's record is read a month at a time, so it has no whole-record view. */
	const month = $derived(gauge && !months.includes(d.month) ? defaultMonth(daily) : d.month);
	const days = $derived(daily.filter((x) => month === 'all' || monthOf(x.t) === month));
	const range = $derived(days.length ? rtRange(days, month) : EMPTY_RANGE);
	const label = $derived(link ? `Daily flow, ${gaugeName(link.station, app.factor)}` : 'Daily flow');
	const series = $derived(days.length ? rtSeries(app.lines, days, null, range, label, app.unit) : []);
	const rows = $derived(app.lines && (f || gauge) ? rtRows(app.lines, gauge ? days : daily, app.unit) : null);
	const codedDays = $derived(daily.filter((x) => isCoded(x.code)).length);
</script>

<FlowImport want="daily" />

{#if d.source === 'gauge' && app.flowsError}
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
		{#if daily.length}
			{countOf(daily.length, 'day')} of flow in {countOf(months.length, 'month')}. {countOf(codedDays, 'day')} with a quality code drawn in their own colour, and {countOf(gauge.missing, 'missing day')} not drawn.
		{:else}
			No daily flow record is held for this gauge.
		{/if}
		{#if !dws}<button type="button" onclick={() => app.showGauge(link.station)}>View gauge record</button>{/if}
	</div>
	<GaugeFactor {link} />
{/if}

{#if (f || gauge) && months.length}
	<div class="controls">
		<MonthSelect {months} all={!gauge} bind:value={() => month, (v) => (d.month = v)} />
	</div>
{/if}

<LineChart title="Historical Comparison, daily flow" axis="time" xRange={range} xLabel={month === 'all' ? 'Date' : 'Days'} yLabel={unitTitle(app.unit)} {series} />

{#if app.unit === 'mm3' && (f || gauge)}
	<p class="muted">In Mm³, each day is the month's volume at that day's flow, so it reads against the monthly EWR.</p>
{/if}

{#if gauge && month !== 'all' && days.length}
	<DayTable {days} {month} unit={app.unit} />
{/if}

{#if rows?.length}
	<DailyMonthTable {rows} unit={app.unit} />
{/if}
