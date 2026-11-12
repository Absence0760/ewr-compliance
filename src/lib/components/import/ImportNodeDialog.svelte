<!--
	One node of an import, opened from the map or the list: what the KML says of it, its files and how
	each EC was decided, and the way to give it files no name matched. A node with no data says so, and
	offers the unmatched files to attach. Every change is uploadMatch.ts's (through the importer).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { KIND_LABEL } from '#lib/ewr/format.ts';
	import { LADDER } from '#lib/ewr/parsers.ts';
	import { attachable } from '#lib/ewr/uploadMatch.ts';
	import type { Importer } from '#lib/components/import/importer.svelte.ts';

	let { importer }: { importer: Importer } = $props();

	let dialog = $state<HTMLDialogElement>();
	let notice = $state<HTMLElement>();
	let pick = $state('');

	const node = $derived(importer.result?.nodes.find((n) => n.id === importer.selected) ?? null);
	const loose = $derived(importer.result ? attachable(importer.result) : []);
	/** The files whose single EC an admin can set (overrideEc): not a Revised run or hydrology. */
	const settable = (kind: string) => kind !== 'revised' && kind !== 'hydro';

	$effect(() => {
		if (node && !dialog?.open) {
			pick = '';
			dialog?.showModal();
		} else if (!node && dialog?.open) dialog.close();
	});

	async function after(work: () => void) {
		work();
		await tick();
		notice?.focus();
	}

	function attach(e: SubmitEvent) {
		e.preventDefault();
		if (!node || !pick) return;
		const file = pick;
		pick = '';
		void after(() => importer.attach(node.id, file));
	}
</script>

<dialog bind:this={dialog} aria-labelledby="import-node-title" onclose={() => (importer.selected = null)}>
	{#if node}
		<div class="head">
			<h2 id="import-node-title">Node {node.label}</h2>
			<button type="button" onclick={() => dialog?.close()}>Close</button>
		</div>
		{#if importer.outside.has(node.id)}
			<p class="notice">This node's point is outside the outline of {importer.area?.name}. Check its coordinates in the KML. It can still be saved.</p>
		{/if}
		<dl>
			<dt>Node id</dt><dd><code>{node.id}</code></dd>
			<dt>River</dt><dd>{node.river || '—'}</dd>
			<dt>Quaternary</dt><dd>{node.quat || '—'}</dd>
			<dt>Location</dt><dd>{node.lon === null ? 'None' : `${node.lon.toFixed(5)}, ${node.lat?.toFixed(5)}`}</dd>
			<dt>PES, REC, TEC</dt><dd>{[node.pes, node.rec, node.tec].map((v) => v || '—').join(', ')}</dd>
			<dt>ECs available</dt><dd>{node.ecsAvailable.join(', ') || 'None'}</dd>
			{#if node.comment}<dt>Comment</dt><dd>{node.comment}</dd>{/if}
			{#if node.ewrNote}<dt>Note</dt><dd>{node.ewrNote}</dd>{/if}
		</dl>

		{#if importer.editMessage}
			<div class="notice {importer.editMessage.level}" tabindex="-1" bind:this={notice} role={importer.editMessage.level === 'error' ? 'alert' : 'status'}>
				{importer.editMessage.text}
			</div>
		{/if}

		<h3>Files</h3>
		{#if !node.files.length}
			<p class="notice nodata">No data matches this node's name. Attach a file from the unmatched files below.</p>
		{:else}
			<div class="tablewrap">
				<table aria-label="Files of {node.label}">
					<thead><tr><th>File</th><th>Kind</th><th>EC</th><th>How it was decided</th><th><span class="sr">Actions</span></th></tr></thead>
					<tbody>
						{#each node.files as f (f.name)}
							<tr>
								<td>{f.name}{f.variant ? ' (variant)' : ''}</td>
								<td>{KIND_LABEL[f.kind]}</td>
								<td>
									{#if settable(f.kind)}
										<select
											aria-label="EC of {f.name}"
											value={f.ec}
											disabled={importer.saving}
											onchange={(e) => after(() => importer.setEc(node.id, f.name, e.currentTarget.value))}
										>
											{#if !f.ec}<option value="">None</option>{/if}
											{#each LADDER as ec (ec)}<option value={ec}>{ec}</option>{/each}
										</select>
									{:else}
										{f.ec || '—'}
									{/if}
								</td>
								<td class="note">
									{f.ecNote ?? ''}
								</td>
								<td>
									<button type="button" disabled={importer.saving} aria-label="Detach {f.name}" onclick={() => after(() => importer.detach(node.id, f.name))}>Detach</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<h3>Attach a file</h3>
		{#if loose.length}
			<form class="controls" onsubmit={attach}>
				<label>Unmatched file
					<select bind:value={pick} disabled={importer.saving}>
						<option value="">Choose a file…</option>
						{#each loose as name (name)}<option value={name}>{name}</option>{/each}
					</select>
				</label>
				<button type="submit" disabled={!pick || importer.saving}>Attach</button>
			</form>
		{:else}
			<p class="muted">No unmatched files to attach. Load a folder with this node's files, or detach one from another node.</p>
		{/if}
	{/if}
</dialog>

<style>
	dialog {
		width: min(760px, 94vw);
		max-height: 90vh;
		padding: 0 16px 16px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 0 8px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}
	h2 {
		margin: 0;
		font-size: 17px;
	}
	h3 {
		margin: 14px 0 4px;
		font-size: 14px;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 2px 12px;
		margin: 10px 0 0;
		font-size: 13px;
	}
	dt {
		color: var(--ink-2);
	}
	dd {
		margin: 0;
	}
	.note {
		font-size: 12px;
		color: var(--ink-2);
	}
	.nodata {
		border-color: var(--critical);
		background: #fbeceb;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
