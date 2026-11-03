<script lang="ts">
	// Where observed flow comes from, for either comparison: source, file or API, and how to read it.
	import { untrack } from 'svelte';
	import { API_DAYS, apiHttpFailure, apiInputProblem, apiRequestFailure, apiTimeoutMs, apiUrl, apiWindow, applyImport, importApi, importFile, pickSheet } from '#lib/ewr/importFlow.ts';
	import { app, type FlowSlot } from '#lib/state/app.svelte.ts';
	import type { FlowSource, FlowUnit, FlowWant, YearIs } from '#lib/ewr/types.ts';

	let { want }: { want: FlowWant } = $props();

	const real = $derived(want === 'instant');
	const slot = $derived(real ? app.rt : app.hist);
	const view = $derived(real ? app.rtView : app.histView);
	const sheet = $derived(slot.sheet);
	const fileLabel = $derived(real ? '12-minute flow file' : 'Monthly flow file');
	const accept = $derived(view.source === 'sheet' ? '.xlsx,.xlsm,.xlsb,.xls,.ods' : '.txt,.csv,.tsv,.dat,.prn,.mrv,.mon,.day');

	/** What is happening now: shown above the status of the data in use, which stays until replaced. */
	let working = $state<{ level: 'info' | 'error'; text: string } | null>(null);
	const saved = untrack(() => (real ? app.rtApi : app.histApi));
	let url = $state(saved.url);
	let station = $state(saved.station);
	let request = 0;

	function commit(next: FlowSlot) {
		working = null;
		if (real) app.setRt(next);
		else app.setHist(next);
	}

	async function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const id = ++request;
		working = { level: 'info', text: 'Reading file…' };
		try {
			const next = await importFile(file, want);
			if (id === request) commit(next);
		} catch (err) {
			if (id === request) working = { level: 'error', text: `Could not read ${file.name}: ${(err as Error).message}` };
		}
		input.value = '';
	}

	async function loadApi() {
		const id = ++request;
		const api = { url: url.trim(), station: station.trim() };
		app.setApi(want, api.url, api.station);
		const problem = apiInputProblem(api.url, api.station);
		if (problem) {
			working = { level: 'error', text: problem };
			return;
		}
		working = { level: 'info', text: 'Loading…' };
		const { from, to } = apiWindow(want, new Date());
		try {
			const res = await fetch(apiUrl(api.url, api.station, from, to), { signal: AbortSignal.timeout(apiTimeoutMs(want)) });
			const body = await res.text();
			if (id !== request) return;
			if (res.ok) commit(importApi(body, api.station, want));
			else working = { level: 'error', text: apiHttpFailure(res.status, body) };
		} catch (err) {
			if (id === request) working = { level: 'error', text: apiRequestFailure(err as Error, want) };
		}
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

<div class="controls">
	<label>Data source
		<select bind:value={() => view.source, setSource}>
			{#if app.link && (real ? app.flowStations.has(app.link.station) : app.gaugeFlow)}
				<option value="gauge">Linked gauge, {app.link.station}</option>
			{/if}
			<option value="sheet">Spreadsheet</option>
			<option value="text">Text file</option>
			<option value="api">API (not yet established)</option>
		</select>
	</label>
	{#if view.source === 'sheet' || view.source === 'text'}
		<label class="file">{fileLabel}
			<input type="file" {accept} onchange={onFile} />
		</label>
	{/if}
</div>

{#if view.source === 'api'}
	<div class="notice info">
		{#if real}
			The DWS real-time API is not yet established, so this form is ready for it and the response format is an assumption. {'{station}'}, {'{from}'} and {'{to}'} in the address are filled in. The response must be JSON rows with a time and a flow in m³/s, or CSV.
		{:else}
			The DWS monthly API is not yet established, so this form is ready for it and the response format is an assumption. {'{station}'}, {'{from}'} and {'{to}'} in the address are filled in, and the request asks for the whole record, from 1900. The response must be JSON rows or CSV: a date and a flow for each month, or a year with month columns. Values are read as Mm³ per month unless a column name gives the unit; check Values are in after loading.
		{/if}
	</div>
	<div class="controls">
		<label>Endpoint
			<input size="44" bind:value={url} placeholder={'https://…/flow?station={station}&from={from}&to={to}'} />
		</label>
		<label>Station
			<input size="10" bind:value={station} placeholder="X0H000" />
		</label>
		<button type="button" onclick={loadApi}>{real ? `Load last ${API_DAYS} days` : 'Load full record'}</button>
	</div>
{/if}

{#if working}
	<div class="notice {working.level}" role={working.level === 'error' ? 'alert' : 'status'}>{working.text}</div>
{/if}
{#if slot.message && sheet && view.source !== 'gauge'}
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
