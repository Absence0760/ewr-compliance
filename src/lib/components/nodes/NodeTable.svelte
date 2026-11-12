<script module lang="ts">
	// Outside the component so the filters survive a trip to the map and back.
	const filters = $state({ basin: '', q: '', only: true });
</script>

<script lang="ts">
	import { app } from '#lib/state/app.svelte.ts';
	import NodeRow from './NodeRow.svelte';

	const COLUMNS = ['Basin', 'Node', 'EWR site', 'Quaternary', 'River', 'PES', 'REC', 'TEC', 'EC in use', 'Method'];

	let table = $state<HTMLTableElement>();
	let copyLabel = $state('Copy table');

	const basins = $derived([...new Set(app.nodes.map((n) => n.basin))]);
	const haystacks = $derived(
		new Map(app.nodes.map((n) => [n.id, [n.label, n.river, n.quat, ...n.sites.map((s) => s.label)].join(' ').toLowerCase()]))
	);
	// Filtering reads only node data, so typing never resolves a view.
	const list = $derived.by(() => {
		const q = filters.q.trim().toLowerCase();
		return app.nodes.filter((n) => {
			if (filters.basin && n.basin !== filters.basin) return false;
			if (filters.only && !n.ecsAvailable.length && !app.uploads[n.id]) return false;
			return !q || haystacks.get(n.id)?.includes(q);
		});
	});

	/** A cell as copied: an EC's chosen value, and no note marked data-nocopy, such as "Added on the site". */
	function cellText(c: HTMLTableCellElement): string {
		const chosen = c.querySelector('select')?.value;
		if (chosen !== undefined) return chosen.trim();
		const copy = c.cloneNode(true) as HTMLTableCellElement;
		for (const e of copy.querySelectorAll('[data-nocopy]')) e.remove();
		return (copy.textContent ?? '').trim();
	}

	async function copyTable() {
		if (!table) return;
		const text = [...table.rows]
			.map((r) => [...r.cells].map(cellText).join('\t'))
			.join('\n');
		try {
			await navigator.clipboard.writeText(text);
			copyLabel = 'Copied';
		} catch {
			copyLabel = 'Copy blocked';
		}
		setTimeout(() => (copyLabel = 'Copy table'), 1500);
	}
</script>

<div class="nodes">
	<h2>Nodes and ECs</h2>
	<div class="controls">
		<label>
			Basin
			<select bind:value={filters.basin}>
				<option value="">All</option>
				{#each basins as b (b)}
					<option value={b}>{b}</option>
				{/each}
			</select>
		</label>
		<label>
			Search
			<input type="search" bind:value={filters.q} placeholder="Node, site, river, quaternary" />
		</label>
		<label class="check"><input type="checkbox" bind:checked={filters.only} /> Only nodes with an EC file available</label>
		<span class="muted" role="status">{list.length} of {app.nodes.length} nodes</span>
		<button type="button" onclick={copyTable}>{copyLabel}</button>
	</div>
	{#if app.nodeStoreNote}
		<p class="muted storenote" role="status">{app.nodeStoreNote}</p>
	{/if}
	<div class="tablewrap">
		<table bind:this={table}>
			<thead>
				<tr>
					{#each COLUMNS as c (c)}
						<th scope="col">{c}</th>
					{/each}
					<th scope="col" class="n">Gazetted EWR %nMAR</th>
				</tr>
			</thead>
			<tbody>
				{#each list as n (n.id)}
					<NodeRow node={n} />
				{:else}
					<tr><td colspan={COLUMNS.length + 1} class="muted">No nodes match these filters.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	/* Fills the view so .tablewrap is the scroller and the sticky header stays in sight. */
	.nodes {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.tablewrap {
		flex: 1;
		min-height: 0;
	}
	.storenote {
		margin: 0 0 8px;
		font-size: 13px;
	}
	input[type='search'] {
		width: 240px;
	}
</style>
