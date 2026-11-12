<!--
	An admin's new node (#17), placed on the WMA's map: where it was clicked, or typed, then its code, label,
	basin, river, quaternary and ECs, and any EWR files chosen from disk. The node is made by the import's own
	matching (newNode in src/lib/ewr/nodeOverlay.ts), so its id, files and ECs are decided as an import's are,
	and saved to the node store through the API. Nothing is sent until Save.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { app } from '#lib/state/app.svelte.ts';
	import { KIND_LABEL } from '#lib/ewr/format.ts';
	import { NODE_STORE_LIMITS } from '#lib/ewr/nodeStore.ts';
	import { newNode, newNodeId, type NewNode } from '#lib/ewr/nodeOverlay.ts';
	import { LADDER } from '#lib/ewr/parsers.ts';
	import { basinsOf } from '#lib/components/import/importer.svelte.ts';
	import { nodeRefusal } from '#lib/users/api.ts';
	import type { Wma } from '#lib/components/map/wma.ts';

	let {
		wma,
		at,
		onclose,
		onsaved
	}: {
		wma: Wma;
		/** Where the admin clicked, or null to type the position. */
		at: { lon: number; lat: number } | null;
		onclose: () => void;
		onsaved: (id: string) => void;
	} = $props();

	let dialog = $state<HTMLDialogElement>();
	// The dialog is made for one placing, on one WMA's map: its props at the start are what it fills in.
	const start = untrack(() => ({ wma, at }));
	const basins = basinsOf(start.wma.slug);
	const round = (v: number) => Math.round(v * 1e5) / 1e5;
	let code = $state('');
	let label = $state('');
	let basin = $state(basins[0] ?? start.wma.name);
	let river = $state('');
	let quat = $state('');
	let pes = $state('');
	let rec = $state('');
	let tec = $state('');
	let lon = $state<number | null>(start.at ? round(start.at.lon) : null);
	let lat = $state<number | null>(start.at ? round(start.at.lat) : null);
	let files = $state.raw<{ name: string; text: string }[]>([]);
	let tooLarge = $state.raw<string[]>([]);
	let reading = $state(false);
	let saving = $state(false);
	let error = $state('');

	const id = $derived(newNodeId(wma.slug, code));
	const exists = $derived(!!id && app.isUploaded(id));
	const placed = $derived(lon !== null && lat !== null && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
	/** The node as it would be saved, worked out by the import's matching. */
	const draft = $derived.by((): NewNode | null => {
		if (!id || !placed) return null;
		try {
			return newNode({ wma: wma.slug, basin, code, label, river, quat, pes, rec, tec, lon: lon!, lat: lat!, files });
		} catch {
			return null;
		}
	});
	const ready = $derived(!!draft && !!basin.trim() && !saving && !reading);

	$effect(() => {
		if (dialog && !dialog.open) dialog.showModal();
	});

	/** Read as the import reads a folder: latin-1, and a file over the store's limit for one file left out and listed. */
	async function choose(list: FileList | null) {
		if (!list?.length) return;
		reading = true;
		error = '';
		try {
			const latin1 = new TextDecoder('latin1');
			const read: { name: string; text: string }[] = [];
			const large: string[] = [];
			for (const f of Array.from(list)) {
				if (f.size > NODE_STORE_LIMITS.fileChars) large.push(f.name);
				else read.push({ name: f.name, text: latin1.decode(await f.arrayBuffer()) });
			}
			files = read;
			tooLarge = large;
		} catch (e) {
			error = `Could not read the files: ${(e as Error).message}`;
		} finally {
			reading = false;
		}
	}

	async function save() {
		const d = draft;
		if (!d || !ready) return;
		saving = true;
		error = '';
		try {
			await app.saveNode(wma.slug, d.node, d.texts);
			app.nodeStoreDone = `Saved ${d.node.label} to ${wma.name}.${d.node.ecsAvailable.length ? '' : ' It has no EWR file, so it shows on the map with Nodes with no EC file switched on.'}`;
			onsaved(d.node.id);
			dialog?.close();
		} catch (e) {
			error = nodeRefusal(e);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet ecs(value: string, set: (v: string) => void)}
	<select {value} onchange={(e) => set(e.currentTarget.value)}>
		<option value="">Not given</option>
		{#each LADDER as ec (ec)}<option value={ec}>{ec}</option>{/each}
	</select>
{/snippet}

<dialog bind:this={dialog} aria-labelledby="add-node-title" onclose={onclose}>
	<div class="head">
		<h2 id="add-node-title">Add a node to {wma.name}</h2>
		<button type="button" onclick={() => dialog?.close()}>Cancel</button>
	</div>
	<p class="muted">Saved to the site for everyone. Files named for the code join it by name; any other EWR file chosen is attached to it.</p>

	<div class="grid">
		<label>Node code (required)
			<input bind:value={code} required aria-describedby="add-node-id" autocomplete="off" />
		</label>
		<label>Label
			<input bind:value={label} placeholder="The code, if left empty" autocomplete="off" />
		</label>
		<p id="add-node-id" class="line full" class:bad={!!code.trim() && !id}>
			{#if !code.trim()}
				Letters, digits, '-' and '_', at most 40.
			{:else if !id}
				{code.trim()} can't be a node code: at most 40 letters, digits, '-' and '_'.
			{:else}
				Saved as {id}.{exists ? ' A node with this code was added already: saving replaces it.' : ''}
			{/if}
		</p>
		<label>Basin
			<input bind:value={basin} list="add-node-basins" required />
		</label>
		<datalist id="add-node-basins">
			{#each basins as b (b)}<option value={b}></option>{/each}
		</datalist>
		<label>River <input bind:value={river} autocomplete="off" /></label>
		<label>Quaternary <input bind:value={quat} size="8" autocomplete="off" /></label>
		<div class="ecs">
			<label>PES {@render ecs(pes, (v) => (pes = v))}</label>
			<label>REC {@render ecs(rec, (v) => (rec = v))}</label>
			<label>TEC {@render ecs(tec, (v) => (tec = v))}</label>
		</div>
		<label>Longitude <input type="number" step="any" min="-180" max="180" bind:value={lon} required /></label>
		<label>Latitude <input type="number" step="any" min="-90" max="90" bind:value={lat} required /></label>
		{#if !placed}
			<p class="line full bad">{at ? 'Give a longitude and latitude in degrees.' : 'Give the longitude and latitude in degrees, or cancel and click the map.'}</p>
		{/if}
		<label class="full">EWR files <span class="muted">(optional: .tab, .rul, _Con.txt and the like)</span>
			<input type="file" multiple onchange={(e) => choose(e.currentTarget.files)} disabled={saving} />
		</label>
	</div>

	{#if reading}
		<p class="line muted" role="status">Reading the files…</p>
	{:else if draft && draft.node.files.length}
		<table aria-label="Files for the new node">
			<thead><tr><th scope="col">File</th><th scope="col">Kind</th><th scope="col">EC</th><th scope="col">How</th></tr></thead>
			<tbody>
				{#each draft.node.files as f (f.name)}
					<tr><td>{f.name}</td><td>{KIND_LABEL[f.kind]}</td><td>{f.ec || '–'}</td><td class="muted">{f.ecNote ?? 'By its name'}</td></tr>
				{/each}
			</tbody>
		</table>
		<p class="line">ECs with an EWR: {draft.node.ecsAvailable.join(', ') || 'none'}</p>
	{:else if files.length && draft}
		<p class="line">None of the files chosen can be this node's.</p>
	{/if}
	{#if draft?.refused.length}
		<div class="notice" role="alert">Not used: {draft.refused.map((r) => `${r.file} (${r.detail})`).join(' ')}</div>
	{/if}
	{#if tooLarge.length}
		<div class="notice" role="alert">Left out, over the limit of {NODE_STORE_LIMITS.fileChars.toLocaleString('en-ZA')} characters for one file: {tooLarge.join(', ')}.</div>
	{/if}
	{#if error}<div class="notice error" role="alert">{error}</div>{/if}

	<div class="actions">
		<button type="button" class="primary" disabled={!ready} onclick={save}>{saving ? 'Saving…' : `Save node to ${wma.name}`}</button>
	</div>
</dialog>

<style>
	dialog {
		width: min(620px, 94vw);
		max-height: 92vh;
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
		gap: 8px;
		padding: 12px 0 6px;
		background: var(--surface);
	}
	h2 {
		margin: 0;
	}
	p {
		margin: 0 0 8px;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 12px;
	}
	.full,
	.ecs {
		grid-column: 1 / -1;
	}
	.ecs {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	.line {
		margin: 0;
		font-size: 13px;
	}
	.bad {
		color: var(--critical);
	}
	table {
		margin: 10px 0 4px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 12px;
	}
	.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	.primary:disabled {
		background: var(--surface-2);
		border-color: #b9b8b0;
		color: var(--ink-3);
		cursor: default;
	}
	@media (max-width: 520px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
