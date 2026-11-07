<script lang="ts">
	// Where observed flow comes from, for either comparison: a linked gauge, our own store of DWS flow kept
	// current, a spreadsheet or a text file, each shown with what it holds. The store is offered for a node
	// with a linked gauge, for that gauge's station, and can only be picked when it holds what this comparison needs.
	import { dwsOffer } from '#lib/ewr/dwsStore.ts';
	import { applyImport, importFile, pickSheet } from '#lib/ewr/importFlow.ts';
	import { app, type FlowSlot } from '#lib/state/app.svelte.ts';
	import type { FlowSource, FlowUnit, FlowWant, YearIs } from '#lib/ewr/types.ts';

	let { want }: { want: FlowWant } = $props();

	type Message = { level: 'info' | 'error'; text: string };

	const real = $derived(want === 'instant');
	const view = $derived(real ? app.rtView : app.histView);
	const file = $derived(view.source === 'sheet' || view.source === 'text');
	const slot = $derived(real ? app.rt : app.hist);
	const sheet = $derived(slot.sheet);
	const fileLabel = $derived(real ? '12-minute flow file' : 'Monthly flow file');
	const accept = $derived(view.source === 'sheet' ? '.xlsx,.xlsm,.xlsb,.xls,.ods' : '.txt,.csv,.tsv,.dat,.prn,.mrv,.mon,.day');
	const gaugeStation = $derived(app.link && (real ? app.flowStations.has(app.link.station) : app.gaugeFlow) ? app.link.station : null);
	const dws = $derived(dwsOffer(app.dws, app.link, want));

	const sources = $derived<{ value: FlowSource; label: string; detail: string; disabled?: boolean }[]>([
		...(gaugeStation
			? [{
				value: 'gauge' as const,
				label: `Linked gauge, ${gaugeStation}`,
				detail: real ? 'Its daily flow and 12-minute readings, held in the app.' : 'Its DWS monthly volumes, held in the app.'
			}]
			: []),
		...(app.link ? [{ value: 'dws' as const, label: `DWS (kept current), ${app.link.station}`, detail: dws.detail, disabled: !dws.ok }] : []),
		{ value: 'sheet', label: 'Spreadsheet', detail: real ? '12-minute or daily flow in m³/s.' : 'Monthly volumes or flows.' },
		{ value: 'text', label: 'Text file', detail: real ? 'A DWS .day file, or a table of dated flows in m³/s.' : 'A DWS .mon file, or a table of monthly volumes or flows.' }
	]);

	/** What is happening now: shown above the status of the data in use, which stays until replaced. */
	let working = $state<Message | null>(null);
	let request = 0;

	function commit(next: FlowSlot) {
		working = null;
		if (real) app.setRt(next);
		else app.setHist(next);
	}

	async function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		if (!picked) return;
		const id = ++request;
		working = { level: 'info', text: 'Reading file…' };
		try {
			const next = await importFile(picked, want);
			if (id === request) commit(next);
		} catch (err) {
			if (id === request) working = { level: 'error', text: `Could not read ${picked.name}: ${(err as Error).message}` };
		}
		input.value = '';
	}

	const setSource = (s: FlowSource) => {
		if (real) app.setRtSource(s);
		else app.setHistSource(s);
		working = null;
	};
	const setSheet = (name: string) => commit(pickSheet(slot, name, want));
	const setUnit = (unitIn: FlowUnit) => commit(applyImport({ ...slot, unitIn }, want));
	const setYearIs = (yearIs: YearIs) => commit(applyImport({ ...slot, yearIs }, want));
</script>

<fieldset class="sources">
	<legend>Data source</legend>
	{#each sources as s (s.value)}
		<label class="source">
			<input type="radio" name="source-{want}" value={s.value} checked={view.source === s.value} disabled={s.disabled} onchange={() => setSource(s.value)} />
			<span><b>{s.label}</b> <span class="muted">{s.detail}</span></span>
		</label>
	{/each}
</fieldset>

{#if file}
	<div class="controls">
		<label class="file">{fileLabel}
			<input type="file" {accept} onchange={onFile} />
		</label>
	</div>
{/if}

{#if working}
	<div class="notice {working.level}" role={working.level === 'error' ? 'alert' : 'status'}>{working.text}</div>
{/if}
{#if file && slot.message && sheet}
	<div class="notice {slot.message.level}" role={slot.message.level === 'error' ? 'alert' : 'status'}><b>{slot.name}.</b> {slot.message.text}</div>
	<div class="controls">
		{#if slot.sheets.length > 1}
			<label>Sheet
				<select bind:value={() => sheet.name, setSheet}>
					{#each slot.sheets as s (s.name)}<option value={s.name}>{s.name}</option>{/each}
				</select>
			</label>
		{/if}
		{#if sheet.layout}
			{#if !real}
				<label>Values are in
					<select bind:value={() => slot.unitIn, setUnit}>
						<option value="mm3">Mm³ per month</option>
						<option value="cumec">m³/s</option>
					</select>
				</label>
			{/if}
			{#if sheet.layout.kind === 'matrix' && sheet.layout.firstMonth !== 1}
				<label>Year label means
					<select bind:value={() => slot.yearIs, setYearIs}>
						<option value="start">Year of October (start)</option>
						<option value="end">Year of September (end)</option>
					</select>
				</label>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.sources {
		border: 0;
		padding: 0;
		margin: 8px 0;
		display: grid;
		gap: 4px;
	}
	legend {
		font-size: 12px;
		color: var(--ink-2);
		padding: 0;
		margin-bottom: 2px;
	}
	.source {
		flex-direction: row;
		align-items: baseline;
		gap: 6px;
		font-size: 13px;
		color: var(--ink);
	}
	.source input {
		padding: 0;
	}
	.source b {
		font-weight: 600;
	}
</style>
