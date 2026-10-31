<script lang="ts">
	// One row owns its own view, so choosing an EC on a row recomputes that row alone.
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { app } from '#lib/state/app.svelte.ts';
	import type { EwrNode } from '#lib/ewr/types.ts';

	let { node: n }: { node: EwrNode } = $props();

	const v = $derived(app.viewOf(n));
	const offTarget = $derived(!!v.ec && !!v.target.ec && v.ec !== v.target.ec && app.choices[n.id]?.ec !== v.ec);
	const method = $derived(
		v.method === 'revised' ? 'Revised .rul' : v.source ? (v.source.kind === 'con' ? '_Con.txt' : '.tab') : ''
	);

	function open(e: MouseEvent) {
		if ((e.target as Element).closest('select')) return;
		// Dragging across a cell to copy its text is not a request to leave the table.
		if (getSelection()?.toString()) return;
		app.select(n.id, { focus: true });
		void goto(resolve('/'));
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<!-- The row click is a mouse convenience; the Node button is the keyboard path to the same action. -->
<tr class:sel={app.selectedId === n.id} onclick={open}>
	<td>{n.basin}</td>
	<td><button type="button" class="nodelink" aria-label="Show {n.label} on the map">{n.label}</button></td>
	<td>{n.sites.map((s) => s.label).join(', ')}</td>
	<td>{n.quat}</td>
	<td>{n.river}</td>
	<td>{n.pes}</td>
	<td>{n.rec}</td>
	<td>{n.tec}</td>
	<td class="ec">
		{#if v.avail.length}
			<select aria-label="EC for {n.label}" value={v.ec} onchange={(e) => app.choose(n.id, { ec: e.currentTarget.value })}>
				{#each v.avail as ec (ec)}
					<option value={ec}>{ec}</option>
				{/each}
			</select>
		{:else}
			<span class="muted">none</span>
		{/if}
		{#if offTarget}
			<span class="off">{v.target.source} {v.target.ec} has no file</span>
		{/if}
	</td>
	<td>{method}</td>
	<td class="n">{n.gazPct ?? ''}</td>
</tr>

<style>
	tr {
		cursor: pointer;
	}
	tr:hover {
		background: var(--surface-2);
	}
	tr.sel:hover {
		background: #e7f0fb;
	}
	.nodelink {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-weight: 600;
		text-align: left;
		text-decoration: underline;
		white-space: nowrap;
	}
	.ec {
		white-space: nowrap;
	}
	select {
		min-width: 58px;
		padding: 1px 4px;
	}
	.off {
		margin-left: 4px;
		font-size: 12px;
		color: var(--ink-2);
	}
</style>
