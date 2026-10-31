<script lang="ts">
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { fmt } from '#lib/ewr/format.ts';
	import { meanMonthly } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { PeriodPreset } from '#lib/ewr/types.ts';
	import { MONTH_RANGE, flowKeys, histRows, histSeries, keyStr, periodLabel, presetRange, strKey, unitName, unitTitle } from './compare.ts';
	import CopyTable from './CopyTable.svelte';
	import FlowImport from './FlowImport.svelte';

	const h = app.histView;
	const f = $derived(app.hist.flow);
	const keys = $derived(f ? flowKeys(f) : null);
	const selected = $derived(f ? meanMonthly(f.records, h.from, h.to) : null);
	const isFull = $derived(!!keys && h.from === keys.first && h.to === keys.last);
	const full = $derived(f && keys && h.overlay && !isFull ? meanMonthly(f.records, keys.first, keys.last) : null);
	const series = $derived(histSeries(app.lines, app.unit, selected, full, periodLabel(h.from, h.to)));
	const rows = $derived(app.lines ? histRows(app.lines, selected, app.unit) : null);
	const u = $derived(unitName(app.unit));
	let table = $state<HTMLTableElement>();

	function setPreset(preset: PeriodPreset) {
		if (!f) return;
		h.preset = preset;
		({ from: h.from, to: h.to } = presetRange(f, preset, h.from, h.to));
	}

	function setBound(which: 'from' | 'to', value: string) {
		if (!value) return;
		h[which] = strKey(value);
		h.preset = 'custom';
		if (h.from > h.to) [h.from, h.to] = [h.to, h.from];
	}
</script>

<FlowImport want="monthly" />

{#if f && keys}
	<div class="controls">
		<label>Period
			<select bind:value={() => h.preset, setPreset}>
				<option value="full">Full record</option>
				<option value="10">Last 10 years</option>
				<option value="20">Last 20 years</option>
				<option value="custom">Custom period</option>
			</select>
		</label>
		<label>From
			<input type="month" min={keyStr(keys.first)} max={keyStr(keys.last)} value={keyStr(h.from)} onchange={(e) => setBound('from', e.currentTarget.value)} />
		</label>
		<label>To
			<input type="month" min={keyStr(keys.first)} max={keyStr(keys.last)} value={keyStr(h.to)} onchange={(e) => setBound('to', e.currentTarget.value)} />
		</label>
		<label class="check"><input type="checkbox" bind:checked={h.overlay} /> Show full record too</label>
	</div>
{/if}

<LineChart title="Historical Comparison" axis="month" xRange={MONTH_RANGE} xLabel="Month" yLabel={unitTitle(app.unit)} {series} />

{#if rows}
	<div class="tablehead">
		<h3>Monthly comparison, {u}</h3>
		<CopyTable {table} />
	</div>
	<div class="tablewrap">
		<table bind:this={table}>
			<thead>
				<tr>
					<th>Month</th>
					<th class="n">EWR Monthly Requirement</th>
					<th class="n">Urgent action required</th>
					<th class="n">Drought EWR</th>
					{#if selected}
						<th class="n">Mean Mm³</th>
						{#if app.unit !== 'mm3'}<th class="n">Mean {u}</th>{/if}
						<th class="n">% of EWR</th>
						<th class="n">Years ≥ EWR</th>
						<th class="n">Years ≥ Drought</th>
						<th class="n">Years</th>
						<th>Status of mean</th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.month)}
					<tr>
						<td>{r.month}</td>
						<td class="n">{fmt(r.ewr)}</td>
						<td class="n">{fmt(r.urgent)}</td>
						<td class="n">{fmt(r.drought)}</td>
						{#if selected}
							<td class="n">{fmt(r.mean)}</td>
							{#if app.unit !== 'mm3'}<td class="n">{fmt(r.meanInUnit)}</td>{/if}
							<td class="n">{fmt(r.pct, 0)}</td>
							<td class="n">{fmt(r.met, 0)}%</td>
							<td class="n">{fmt(r.metDrought, 0)}%</td>
							<td class="n">{r.years}</td>
							<td><span class="status {r.status?.key}">{r.status?.label}</span></td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
