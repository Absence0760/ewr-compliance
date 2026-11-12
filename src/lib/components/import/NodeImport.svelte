<!--
	The admin import panel (#17, P4): choose a WMA, load its node KML, then a folder of EWR files. The
	files are matched to the nodes as they load, a node no file matched is flagged on the map and in the
	list, and its panel attaches files by hand. Nothing is saved until Save, which sends the nodes one
	by one to the API. For admins only: the API refuses anyone else, and this page says so first.
-->
<script lang="ts">
	import { session } from '#lib/state/session.svelte.ts';
	import { WMAS } from '#lib/components/map/wma.ts';
	import { LADDER } from '#lib/ewr/parsers.ts';
	import { NODE_STORE_LIMITS } from '#lib/ewr/nodeStore.ts';
	import { attachable } from '#lib/ewr/uploadMatch.ts';
	import { Importer, basinsOf } from '#lib/components/import/importer.svelte.ts';
	import ImportMap from '#lib/components/import/ImportMap.svelte';
	import ImportNodeDialog from '#lib/components/import/ImportNodeDialog.svelte';

	const importer = new Importer();
	const me = $derived(session.me);

	type Show = 'all' | 'nodata' | 'noewr' | 'outside';
	let show = $state<Show>('all');

	const r = $derived(importer.result);
	const noFiles = $derived(new Set(r?.report.nodesWithoutFiles ?? []));
	const noEwr = $derived(new Set(r?.report.nodesWithoutEwr ?? []));
	const loose = $derived(r ? new Set(attachable(r)) : new Set<string>());
	const shown = $derived(
		(r?.nodes ?? []).filter((n) =>
			show === 'nodata' ? noFiles.has(n.id) : show === 'noewr' ? noEwr.has(n.id) : show === 'outside' ? importer.outside.has(n.id) : true
		)
	);
	const skipped = $derived([
		...(r?.report.kmlSkipped ?? importer.kmlSkipped).map((s) => ({ name: s.name, folder: s.folder, reason: s.reason })),
		...(r?.report.placemarks ?? [])
	]);
	const labelOf = (id: string) => r?.nodes.find((n) => n.id === id)?.label ?? id;
	const emptyCount = $derived(noFiles.size);
	const basinMissing = $derived(!importer.basin.trim());

	const REASON: Record<string, string> = {
		'no-node': 'No node',
		ambiguous: 'More than one node',
		'unknown-type': 'Not a Desktop output',
		skipped: 'Left out',
		duplicate: 'Same name twice',
		detached: 'Detached'
	};
	const HOW: Record<string, string> = { 'ec-copy': 'Copy of the header’s run', 'ec-header': 'Distinct run: file name', admin: 'Set by an admin' };
</script>

{#if !session.checked || session.leaving || !me?.admin}
	<section class="view prose">
		<h2>Import nodes</h2>
		{#if !session.checked}
			<p class="muted" role="status">Loading…</p>
		{:else if session.leaving}
			<p class="muted" role="status">Your sign-in has ended. Opening the sign-in page…</p>
		{:else if !me}
			<p>This copy of the site has no user list, so nothing can be saved here. Nodes are imported on the hosted site, by its admins.</p>
		{:else}
			<p>You are signed in as {me.email}. Only an admin can import nodes: ask one if a WMA's nodes need adding.</p>
		{/if}
	</section>
{:else}
	<section class="view split">
		{#if importer.area}
			{#key importer.area.slug}
				<ImportMap
					wma={importer.area}
					nodes={r?.nodes ?? []}
					boundary={importer.boundary}
					boundaryState={importer.boundaryState}
					selected={importer.selected}
					onselect={(id) => (importer.selected = id)}
				/>
			{/key}
		{:else}
			<section class="wrap" aria-label="Map of imported nodes">
				<p class="emptystate pad">Choose a Water Management Area, and its map shows here with the KML's nodes once it loads.</p>
			</section>
		{/if}

		<aside class="panel" aria-label="Import">
			<h2>Import nodes</h2>
			<p class="muted intro">Load a WMA's node KML, then its EWR files. Files are matched to nodes by name as they load. Nothing is saved until you press Save.</p>

			<fieldset>
				<legend>1. Node locations</legend>
				<div class="controls">
					<label>Water Management Area
						<select value={importer.wma} onchange={(e) => importer.setWma(e.currentTarget.value)} disabled={importer.saving}>
							<option value="" disabled>Choose a WMA…</option>
							{#each WMAS as w (w.slug)}<option value={w.slug}>{w.name}</option>{/each}
						</select>
					</label>
					<label>Basin
						<input
							list="import-basins"
							size="16"
							value={importer.basin}
							disabled={!importer.wma || importer.saving}
							oninput={(e) => importer.setBasin(e.currentTarget.value)}
						/>
					</label>
					<datalist id="import-basins">
						{#each basinsOf(importer.wma) as b (b)}<option value={b}></option>{/each}
					</datalist>
					<label>Load node KML
						<input type="file" accept=".kml" disabled={!importer.wma || importer.saving} onchange={(e) => importer.loadKml(e.currentTarget.files?.[0])} />
					</label>
				</div>
				{#if importer.kmlMessage}
					<div class="notice error" role="alert">{importer.kmlMessage.text}</div>
				{:else if importer.kmlName}
					<p class="line" role="status">
						{importer.kmlName}: {importer.placemarks.length} placemarks read, {importer.kmlSkipped.length} skipped{r ? `, ${r.nodes.length} nodes` : ''}.
					</p>
				{/if}
				{#if basinMissing && importer.wma}
					<div class="notice error" role="alert">Give the basin the nodes are in.</div>
				{/if}
			</fieldset>

			<fieldset disabled={!importer.placemarks.length || importer.saving}>
				<legend>2. EWR files</legend>
				<div class="controls">
					<label>Load EWR files from a folder
						<input type="file" webkitdirectory multiple onchange={(e) => importer.loadFiles(e.currentTarget.files)} />
					</label>
					<label>Or choose the files
						<input type="file" multiple onchange={(e) => importer.loadFiles(e.currentTarget.files)} />
					</label>
				</div>
				{#if importer.reading}
					<p class="line muted" role="status">Reading the files…</p>
				{:else if importer.filesMessage}
					<div class="notice error" role="alert">{importer.filesMessage.text}</div>
				{:else if importer.files.length || importer.tooLarge.length}
					<p class="line" role="status">
						{importer.files.length} files read and matched{r ? `: ${r.report.files.length} joined a node, ${r.report.unmatched.length} did not` : ''}.
					</p>
				{/if}
				{#if importer.tooLarge.length}
					<div class="notice" role="alert">
						Left out, over the limit of {NODE_STORE_LIMITS.fileChars.toLocaleString('en-ZA')} characters for one file: {importer.tooLarge.join(', ')}.
					</div>
				{/if}
			</fieldset>

			{#if r}
				<div class="chips" aria-label="Summary">
					<span class="chip"><b>{r.nodes.length}</b> nodes</span>
					<span class="chip"><b>{r.nodes.length - noFiles.size}</b> with data</span>
					<span class="chip" class:flag={noFiles.size > 0}><b>{noFiles.size}</b> with no data</span>
					<span class="chip"><b>{r.report.unmatched.length}</b> files unmatched</span>
					<span class="chip"><b>{r.report.ecDecisions.length}</b> EC decisions</span>
					{#if importer.boundaryState === 'loaded'}
						<span class="chip" class:flag={importer.outside.size > 0}><b>{importer.outside.size}</b> outside the WMA</span>
					{/if}
				</div>

				{#if importer.boundaryState === 'lost'}
					<div class="notice" role="alert">The WMA boundary could not be loaded from the DWS service, so the nodes were not checked against it. You can still save.</div>
				{:else if importer.outside.size}
					<div class="notice" role="alert">
						{importer.outside.size === 1 ? 'One node is' : `${importer.outside.size} nodes are`} outside the outline of {importer.area?.name}: check the KML's coordinates. They can still be saved.
					</div>
				{/if}
				{#if r.report.overLimits.length}
					<div class="notice error" role="alert">
						Over the store's limits, so not saved: {r.report.overLimits.map((o) => `${o.nodeId ? `${labelOf(o.nodeId)}: ` : ''}${o.detail}`).join(' ')}
					</div>
				{/if}

				<section class="save" aria-labelledby="import-save">
					<h3 id="import-save">Save</h3>
					<label class="check">
						<input type="checkbox" bind:checked={importer.includeEmpty} disabled={importer.saving} />
						Also save the {emptyCount} {emptyCount === 1 ? 'node' : 'nodes'} with no data, as locations only
					</label>
					<div class="controls">
						<button type="button" class="primary" disabled={importer.saving || !importer.toSave.length || basinMissing} onclick={() => importer.save()}>
							Save {importer.toSave.length} {importer.toSave.length === 1 ? 'node' : 'nodes'} to {importer.area?.name}
						</button>
						{#if importer.progress}
							<span role="status">
								{importer.saving ? `Saving ${Math.min(importer.progress.done + 1, importer.progress.total)} of ${importer.progress.total}…` : `Saved ${importer.progress.done - importer.failures.length} of ${importer.progress.total}.`}
							</span>
						{/if}
					</div>
					{#if importer.stopped}
						<div class="notice error" role="alert">{importer.stopped}</div>
					{/if}
					{#if importer.failures.length && !importer.saving}
						<div class="notice error" role="alert">
							<p>Not saved:</p>
							<ul>
								{#each importer.failures as f (f.id)}<li>{labelOf(f.id)}: {f.text}</li>{/each}
							</ul>
							<p>Press Save again to send only the nodes not saved.</p>
						</div>
					{/if}
					{#if importer.saved.size && !importer.saving && !importer.toSave.length}
						<div class="notice info" role="status">Every node of this import is saved.</div>
					{/if}
				</section>

				<div class="tablehead">
					<h3 id="import-nodes">Nodes</h3>
					<label class="inline">Show
						<select bind:value={show}>
							<option value="all">All nodes ({r.nodes.length})</option>
							<option value="nodata">With no data ({noFiles.size})</option>
							<option value="noewr">Files but no EWR ({noEwr.size})</option>
							<option value="outside">Outside the WMA ({importer.outside.size})</option>
						</select>
					</label>
				</div>
				<div class="tablewrap list">
					<table aria-labelledby="import-nodes">
						<thead><tr><th>Node</th><th>River</th><th>Files and ECs</th><th>Status</th></tr></thead>
						<tbody>
							{#each shown as n (n.id)}
								<tr class:sel={importer.selected === n.id}>
									<td><button type="button" class="link" onclick={() => (importer.selected = n.id)}>{n.label}</button></td>
									<td>{n.river}</td>
									<td>
										{#each n.files as f (f.name)}<div>{f.name}{f.ec ? ` · ${f.ec}` : ''}</div>{/each}
									</td>
									<td>
										{#if noFiles.has(n.id)}
											<span class="status critical">No data matches this node's name</span>
										{:else if noEwr.has(n.id)}
											<span class="status warning">Files but no EWR</span>
										{:else}
											<span class="status good">ECs {n.ecsAvailable.join(', ')}</span>
										{/if}
										{#if importer.outside.has(n.id)}<div class="status warning">Outside the WMA</div>{/if}
										{#if importer.saved.has(n.id)}<div class="muted">Saved</div>{/if}
									</td>
								</tr>
							{:else}
								<tr><td colspan="4" class="muted">No node is like that.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>

				<h3 id="import-unmatched">Unmatched files ({r.report.unmatched.length})</h3>
				{#if r.report.unmatched.length}
					<p class="muted line">Open a node to attach one of these to it.</p>
					<div class="tablewrap list">
						<table aria-labelledby="import-unmatched">
							<thead><tr><th>File</th><th>Why</th><th>Can be attached</th></tr></thead>
							<tbody>
								{#each r.report.unmatched as u, i (`${u.file}:${i}`)}
									<tr><td>{u.file}</td><td>{REASON[u.reason]}: {u.detail}</td><td>{loose.has(u.file) ? 'Yes' : 'No'}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="muted line">Every file joined a node.</p>
				{/if}

				<h3 id="import-decisions">EC decisions ({r.report.ecDecisions.length})</h3>
				{#if r.report.ecDecisions.length}
					<p class="muted line">Where a file's name and its header give different ECs. Change one if the decision is wrong.</p>
					<div class="tablewrap list">
						<table aria-labelledby="import-decisions">
							<thead><tr><th>Node</th><th>File</th><th>Name</th><th>Header</th><th>How</th><th>EC used</th></tr></thead>
							<tbody>
								{#each r.report.ecDecisions as d (`${d.nodeId}:${d.file}`)}
									<tr>
										<td>{labelOf(d.nodeId)}</td>
										<td>{d.file}</td>
										<td>{d.nameEc || '—'}</td>
										<td>{d.headerEc || '—'}</td>
										<td title={d.detail}>{HOW[d.kind]}</td>
										<td>
											<select aria-label="EC used for {d.file}" value={d.ec} disabled={importer.saving} onchange={(e) => importer.setEc(d.nodeId, d.file, e.currentTarget.value)}>
												{#each LADDER as ec (ec)}<option value={ec}>{ec}</option>{/each}
											</select>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if importer.editMessage && !importer.selected}
						<div class="notice {importer.editMessage.level}" role={importer.editMessage.level === 'error' ? 'alert' : 'status'}>{importer.editMessage.text}</div>
					{/if}
				{:else}
					<p class="muted line">No file's name and header disagree.</p>
				{/if}
			{/if}

			{#if skipped.length}
				<h3 id="import-skipped">KML points skipped ({skipped.length})</h3>
				<div class="tablewrap list">
					<table aria-labelledby="import-skipped">
						<thead><tr><th>Placemark</th><th>Folder</th><th>Why</th></tr></thead>
						<tbody>
							{#each skipped as s, i (i)}
								<tr><td>{s.name || '(no name)'}</td><td>{s.folder ?? ''}</td><td>{s.reason}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</aside>
	</section>
	<ImportNodeDialog {importer} />
{/if}

<style>
	.intro {
		margin: 0 0 6px;
	}
	fieldset {
		border: 1px solid var(--line);
		border-radius: 6px;
		margin: 8px 0;
		padding: 4px 12px 8px;
	}
	legend {
		font-weight: 600;
		padding: 0 4px;
	}
	.line {
		margin: 4px 0;
		font-size: 13px;
	}
	h3 {
		font-size: 14px;
		margin: 14px 0 4px;
	}
	.tablehead h3 {
		margin: 0;
	}
	.chip.flag {
		background: #fbeceb;
	}
	.save {
		margin: 8px 0;
		padding: 6px 12px 8px;
		background: var(--surface-2);
		border-radius: 6px;
	}
	.save h3 {
		margin: 2px 0 4px;
	}
	.save .notice p {
		margin: 2px 0;
	}
	.save .notice ul {
		margin: 2px 0;
		padding-left: 18px;
	}
	button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	button.primary:disabled {
		background: var(--surface-2);
		border-color: #b9b8b0;
		color: var(--ink-3);
		cursor: default;
	}
	button.link {
		border: 0;
		background: none;
		padding: 2px 0;
		color: var(--accent);
		text-decoration: underline;
		font-weight: 600;
	}
	.list {
		max-height: 42vh;
	}
	td {
		vertical-align: top;
	}
	.wrap {
		border-right: 1px solid var(--line);
	}
	.pad {
		margin: 30vh auto 0;
		padding: 14px;
		max-width: 36ch;
		text-align: center;
	}
	/* Status words wrap here, so a narrow panel shows them whole. */
	td .status {
		white-space: normal;
	}
</style>
