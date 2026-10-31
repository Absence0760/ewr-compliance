<script lang="ts">
	import { PERCENTILES } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { FlowBasis, FlowUnit, Method } from '#lib/ewr/types.ts';
	import { ecOptionLabel } from './compare.ts';

	const n = $derived(app.selected);
	const v = $derived(app.view);
	const c = $derived(n ? (app.choices[n.id] ?? {}) : {});
	const files = $derived(n ? app.filesOf(n) : []);
	let uploadError = $state<{ id: string; text: string } | null>(null);

	async function addRevised(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !n) return;
		const id = n.id;
		uploadError = null;
		try {
			app.addRevised(id, file.name, await file.text());
		} catch (err) {
			uploadError = { id, text: `${file.name}: ${(err as Error).message}` };
		}
		input.value = '';
	}

	function viewFile(e: Event) {
		const sel = e.currentTarget as HTMLSelectElement;
		if (n && sel.value) app.openFile(n.id, sel.value);
		sel.value = '';
	}
</script>

<div class="controls">
	{#if n && v}
		{#if n.basin === 'Olifants-Doring'}
			<label>Flow basis
				<select bind:value={() => v.basis, (basis: FlowBasis) => app.choose(n.id, { basis })}>
					<option value="cum">Cumulative</option>
					<option value="inc">Incremental</option>
				</select>
			</label>
		{/if}
		{#if v.avail.length}
			<label>Ecological Category
				<select bind:value={() => v.ec, (ec: string) => app.choose(n.id, { ec })}>
					{#each v.avail as e (e)}<option value={e}>{ecOptionLabel(n, e, v.basis)}</option>{/each}
				</select>
			</label>
			<label>Method
				<select bind:value={() => v.method, (method: Method) => app.choose(n.id, { method })}>
					{#if v.sources.length}<option value="tab">Reserve Desktop (.tab)</option>{/if}
					{#if v.hasRevised}<option value="revised">Revised Reserve Desktop (.rul)</option>{/if}
				</select>
			</label>
		{/if}
		{#if v.method === 'tab' && v.sources.length > 1}
			<label>EWR source file
				<select bind:value={() => v.source?.name ?? '', (source: string) => app.choose(n.id, { source })}>
					{#each v.sources as f (f.name)}<option value={f.name}>{f.name.replace(/^(Inc|Cum)\//, '')}</option>{/each}
				</select>
			</label>
		{/if}
		{#if v.method === 'revised' && v.ec}
			<label>EWR percentile
				<select bind:value={() => c.pct ?? 50, (pct: number) => app.choose(n.id, { pct })}>
					{#each PERCENTILES as p (p)}<option value={p}>{p}th</option>{/each}
				</select>
			</label>
			<label>Drought EWR percentile
				<select bind:value={() => c.dpct ?? 90, (dpct: number) => app.choose(n.id, { dpct })}>
					<option value={90}>90th</option>
					<option value={99}>99th</option>
				</select>
			</label>
		{/if}
	{/if}
	<label>Units
		<select bind:value={() => app.unit, (u: FlowUnit) => (app.unit = u)}>
			<option value="cumec">m³/s</option>
			<option value="mm3">Mm³ per month</option>
		</select>
	</label>
	{#if n}
		<label>View file
			<select onchange={viewFile}>
				<option value="">Choose a file</option>
				{#each files as f}<option value={f.name}>{f.name}{f.ec ? ` (${f.ec})` : ''}</option>{/each}
			</select>
		</label>
		<label class="file">Add Revised .rul
			<input type="file" onchange={addRevised} />
		</label>
	{/if}
</div>
{#if uploadError && uploadError.id === n?.id}
	<div class="notice error" role="alert">{uploadError.text}</div>
{/if}
