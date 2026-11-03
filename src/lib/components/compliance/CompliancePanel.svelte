<script lang="ts">
	import { app } from '#lib/state/app.svelte.ts';
	import { tecOf } from './compare.ts';
	import GaugePanel from './GaugePanel.svelte';
	import HistoricalTab from './HistoricalTab.svelte';
	import NodeControls from './NodeControls.svelte';
	import RealTimeTab from './RealTimeTab.svelte';

	const TABS = [
		{ id: 'hist', label: 'Historical Comparison' },
		{ id: 'rt', label: 'Real Time Comparison' }
	] as const;

	const n = $derived(app.selected);
	const v = $derived(app.view);
	let tabEls: HTMLButtonElement[] = $state([]);

	function onTabKey(e: KeyboardEvent, i: number) {
		const last = TABS.length - 1;
		const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
		if (next === undefined) return;
		e.preventDefault();
		app.tab = TABS[next].id;
		tabEls[next].focus();
	}
</script>

<aside class="panel" aria-label="Compliance">
	{#if app.gaugeView}
		<GaugePanel station={app.gaugeView.station} name={app.gaugeView.name} />
	{/if}
	<!-- Stays mounted under a gauge's record, so a loaded file and its choices are there on the way back. -->
	<div hidden={!!app.gaugeView}>
		{#if n && v}
			<div class="nodehead">
				<h2>{n.label}{#if n.sites.length}{' '}<span class="muted">/ {n.sites.map((s) => s.label).join(', ')}</span>{/if}</h2>
				<span class="muted">{n.river} · {n.quat} · {n.basin}{n.iua ? ` · IUA ${n.iua}` : ''}</span>
			</div>
			<div class="chips">
				<span class="chip">PES <b>{n.pes || '–'}</b></span>
				<span class="chip">REC <b>{n.rec || '–'}</b></span>
				<span class="chip">TEC <b>{tecOf(n, v.basis) || '–'}</b></span>
				<span class="chip use">EC in use <b>{v.ec || 'none'}</b></span>
				{#if n.gazPct}<span class="chip">Gazetted EWR <b>{n.gazPct}%</b> nMAR</span>{/if}
			</div>
		{:else}
			<div class="emptystate">
				<h2>Select a node on the map</h2>
				<p>Click any EWR node or site to show its EWR lines, or load observed flows below first and then move between nodes.</p>
			</div>
		{/if}

		<NodeControls />

		{#each app.notices as note}
			<div class="notice {note.level}">{note.text}</div>
		{/each}

		<div class="tabs" role="tablist" aria-label="Comparison">
			{#each TABS as t, i (t.id)}
				<button
					type="button"
					role="tab"
					id="tab-{t.id}"
					aria-selected={app.tab === t.id}
					aria-controls="panel-{t.id}"
					tabindex={app.tab === t.id ? 0 : -1}
					bind:this={tabEls[i]}
					onclick={() => (app.tab = t.id)}
					onkeydown={(e) => onTabKey(e, i)}
				>
					{t.label}
				</button>
			{/each}
		</div>
		<div role="tabpanel" id="panel-hist" aria-labelledby="tab-hist" hidden={app.tab !== 'hist'}>
			<HistoricalTab />
		</div>
		<div role="tabpanel" id="panel-rt" aria-labelledby="tab-rt" hidden={app.tab !== 'rt'}>
			<RealTimeTab />
		</div>
	</div>
</aside>
