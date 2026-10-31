<script lang="ts">
	// Line chart on uPlot, with its own legend and crosshair readout: a step line and daily flow
	// sit on different x values, so the value under the cursor comes from each series, not an index.
	// The readout floats over the plot, so hovering never moves the chart under the pointer.
	import { untrack } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { MONTHS } from '#lib/ewr/parsers.ts';
	import { fmt } from '#lib/ewr/format.ts';
	import { chartSummary, timeReadout, timeStep, timeTick, timeTicks, valueAt, type ChartAxis, type ChartSeries } from './chart.ts';

	let { title, axis, xRange, xLabel, yLabel, series }: {
		title: string;
		axis: ChartAxis;
		xRange: [number, number];
		xLabel: string;
		yLabel: string;
		series: ChartSeries[];
	} = $props();

	const AXIS = '#52514e';
	const GRID = '#ecebe5';
	const FONT = '12px system-ui, sans-serif';
	const MONTH_TICKS = MONTHS.map((_, i) => i);

	let host: HTMLDivElement | undefined = $state();
	let plot: uPlot | null = null;
	let size = $state({ w: 0, h: 0 });
	let cursor = $state<{ x: number; left: number; top: number } | null>(null);
	/** Legend clicks by label, so a rebuild keeps what was switched off. */
	let off = $state<Record<string, boolean>>({});

	const hasData = $derived(series.some((s) => s.y.some((v) => v !== null)));
	const xText = (v: number) => (axis === 'month' ? (MONTHS[Math.round(v)] ?? '') : timeReadout(v));
	const span = $derived(
		axis === 'time' && hasData ? `${timeReadout(xRange[0]).slice(0, 10)} to ${timeReadout(xRange[1]).slice(0, 10)}` : ''
	);
	const summary = $derived(chartSummary(title, xLabel, yLabel, series, span));
	// Drawn in reverse so the first series, the flow, sits on top.
	const drawn = $derived([...series].reverse());
	const uIndex = (s: ChartSeries) => drawn.indexOf(s) + 1;

	function seriesOpts(s: ChartSeries): uPlot.Series {
		return {
			label: s.label,
			stroke: s.color,
			width: s.width ?? 2,
			dash: s.dash,
			show: !off[s.label],
			paths: s.stepped ? uPlot.paths.stepped!({ align: 1 }) : undefined,
			points: s.markers
				? { show: true, size: s.dash ? 6 : 8, width: 1.5, stroke: '#fff', fill: s.color }
				: { show: false }
		};
	}

	function yRange(_u: uPlot, _min: number | null, max: number | null): uPlot.Range.MinMax {
		return [0, max !== null && max > 0 ? uPlot.rangeNum(0, max, 0.1, true)[1] : 1];
	}

	function xAxis(): uPlot.Axis {
		const base = { stroke: AXIS, font: FONT, labelFont: FONT, label: xLabel, labelSize: 16, labelGap: 0, size: 32, grid: { show: false }, ticks: { stroke: GRID } };
		if (axis === 'month') {
			return {
				...base,
				splits: () => MONTH_TICKS,
				values: (u, ticks) => ticks.map((t, i) => (u.bbox.width / uPlot.pxRatio >= 12 * 30 || i % 2 === 0 ? MONTHS[t] : ''))
			};
		}
		const step = (u: uPlot) => timeStep(u.scales.x.max! - u.scales.x.min!, u.bbox.width / uPlot.pxRatio, xLabel === 'Days' ? 30 : 52);
		return {
			...base,
			splits: (u, _i, min, max) => timeTicks(xRange[0], min, max, step(u)),
			values: (u, ticks) => (hasData ? ticks.map((t) => timeTick(t, step(u), xLabel === 'Days')) : ticks.map(() => ''))
		};
	}

	function build() {
		plot?.destroy();
		plot = null;
		cursor = null;
		if (!host || size.w <= 0 || size.h <= 0) return;
		// xRange joins as a table of its own, so the axis spans it and a double-click returns to it.
		const joined = uPlot.join([[xRange], ...drawn.map((s): uPlot.AlignedData => [s.x, s.y])]);
		const opts: uPlot.Options = {
			width: size.w,
			height: size.h,
			legend: { show: false },
			// Series left to fill the y scale for an empty chart, so its axis still draws.
			series: [{}, ...(drawn.length ? drawn.map(seriesOpts) : [{ show: false }])],
			scales: { x: { time: false }, y: { range: yRange } },
			cursor: { points: { show: false }, drag: { x: axis === 'time', y: false } },
			axes: [
				xAxis(),
				{ stroke: AXIS, font: FONT, labelFont: FONT, label: yLabel, labelSize: 18, size: 50, space: 36, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID } }
			],
			hooks: {
				setCursor: [
					(u) => {
						const { left = -1, top = 0 } = u.cursor;
						cursor = left >= 0 ? { x: u.posToVal(left, 'x'), left: left + u.over.offsetLeft, top: top + u.over.offsetTop } : null;
					}
				]
			}
		};
		const data = (drawn.length ? joined : [joined[0], [null, null]]) as uPlot.AlignedData;
		plot = new uPlot(opts, data, host);
		plot.ctx.canvas.setAttribute('role', 'img');
		plot.ctx.canvas.setAttribute('aria-label', summary);
	}

	function toggle(s: ChartSeries) {
		off[s.label] = !off[s.label];
		plot?.setSeries(uIndex(s), { show: !off[s.label] });
	}

	$effect(() => {
		if (!host) return;
		const ro = new ResizeObserver(([e]) => {
			size = { w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) };
		});
		ro.observe(host);
		return () => ro.disconnect();
	});

	$effect(() => {
		void [series, xRange, axis, xLabel, yLabel, host];
		untrack(build);
		return () => {
			plot?.destroy();
			plot = null;
		};
	});

	// A resize keeps the plot, and any zoom, rather than rebuilding it.
	$effect(() => {
		const { w, h } = size;
		untrack(() => {
			if (plot) plot.setSize({ width: w, height: h });
			else build();
		});
	});
</script>

<figure>
	{#if series.length >= 2}
		<ul class="keys" aria-label="{title} legend">
			{#each series as s (s.label)}
				<li>
					<button type="button" class:off={off[s.label]} aria-pressed={!off[s.label]} title="Show or hide {s.label}" onclick={() => toggle(s)}>
						{@render swatch(s)}
						{s.label}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="chartbox">
		<div class="plot" bind:this={host}></div>
		{#if cursor}
			{@const flip = cursor.left > size.w / 2}
			<!-- The table under the chart is the accessible route to these values. -->
			<div class="readout" aria-hidden="true" style:left="{cursor.left}px" style:top="{cursor.top}px" class:flip>
				<div class="at">{xText(cursor.x)}</div>
				{#each series.filter((s) => !off[s.label]) as s (s.label)}
					{@const v = valueAt(s, cursor.x)}
					<div class="row">{@render swatch(s)}<span>{s.label}</span><b>{v === null ? 'no data' : fmt(v)}</b></div>
				{/each}
			</div>
		{/if}
	</div>
</figure>

{#snippet swatch(s: ChartSeries)}
	<svg width="24" height="10" aria-hidden="true">
		<line x1="0" y1="5" x2="24" y2="5" stroke={s.color} stroke-width="2" stroke-dasharray={s.dash?.join(' ')} />
		{#if s.markers}<circle cx="12" cy="5" r="3.5" fill={s.color} stroke="#fff" />{/if}
	</svg>
{/snippet}

<style>
	figure {
		margin: 0;
		min-width: 0;
	}
	.keys {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
		font-size: 13px;
	}
	.keys button {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		padding: 2px 4px;
		border: 0;
		background: none;
		white-space: nowrap;
	}
	.keys button:hover {
		background: var(--surface-2);
	}
	.keys button.off {
		color: var(--ink-3);
		text-decoration: line-through;
	}
	.keys button.off svg {
		opacity: 0.35;
	}
	.plot {
		position: absolute;
		inset: 0;
	}
	.plot :global(.u-select) {
		background: rgba(31, 95, 174, 0.12);
	}
	.readout {
		position: absolute;
		z-index: 2;
		transform: translate(12px, 12px);
		padding: 5px 8px;
		border: 1px solid var(--line);
		border-radius: 5px;
		background: var(--surface);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
		font-size: 12px;
		white-space: nowrap;
		pointer-events: none;
	}
	.readout.flip {
		transform: translate(calc(-100% - 12px), 12px);
	}
	.at {
		margin-bottom: 2px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.row b {
		margin-left: auto;
		padding-left: 10px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
</style>
