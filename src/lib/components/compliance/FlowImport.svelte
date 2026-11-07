<script lang="ts">
	// Where observed flow comes from, for either comparison: a linked gauge, the DWS API, a spreadsheet or a
	// text file, each shown with what it holds. The Historical Comparison's API is one request for monthly
	// volumes; the Real Time Comparison's is two, the daily flow record and the latest real-time readings.
	import { untrack } from 'svelte';
	import {
		API_CALL, API_DAYS, apiHttpFailure, apiInputProblem, apiRequestFailure, apiTimeoutMs, apiUrl, apiWindow, applyImport, importApi, importFile,
		pickSheet, type ApiCall
	} from '#lib/ewr/importFlow.ts';
	import { app, type FlowSlot } from '#lib/state/app.svelte.ts';
	import type { FlowSource, FlowUnit, FlowWant, YearIs } from '#lib/ewr/types.ts';

	let { want }: { want: FlowWant } = $props();

	type Message = { level: 'info' | 'error'; text: string };

	const real = $derived(want === 'instant');
	const view = $derived(real ? app.rtView : app.histView);
	const api = $derived(view.source === 'api');
	/** The slot the Historical Comparison reads and sets up: the API's own, or the file's. */
	const slot = $derived(real ? app.rt : api ? app.histApiSlot : app.hist);
	const sheet = $derived(slot.sheet);
	const calls: ApiCall[] = $derived(real ? ['daily', 'readings'] : ['monthly']);
	const fileLabel = $derived(real ? '12-minute flow file' : 'Monthly flow file');
	const accept = $derived(view.source === 'sheet' ? '.xlsx,.xlsm,.xlsb,.xls,.ods' : '.txt,.csv,.tsv,.dat,.prn,.mrv,.mon,.day');
	const gaugeStation = $derived(app.link && (real ? app.flowStations.has(app.link.station) : app.gaugeFlow) ? app.link.station : null);

	const sources = $derived<{ value: FlowSource; label: string; detail: string }[]>([
		...(gaugeStation
			? [{
				value: 'gauge' as const,
				label: `Linked gauge, ${gaugeStation}`,
				detail: real ? 'Its daily flow and 12-minute readings, held in the app.' : 'Its DWS monthly volumes, held in the app.'
			}]
			: []),
		{
			value: 'api',
			label: 'DWS API',
			detail: real
				? `Two requests: the daily flow record, and real-time readings for the last ${API_DAYS} days. Not yet established.`
				: 'One request: the DWS monthly volumes, the whole record. Not yet established.'
		},
		{ value: 'sheet', label: 'Spreadsheet', detail: real ? '12-minute or daily flow in m³/s.' : 'Monthly volumes or flows.' },
		{ value: 'text', label: 'Text file', detail: real ? 'A DWS .day file, or a table of dated flows in m³/s.' : 'A DWS .mon file, or a table of monthly volumes or flows.' }
	]);

	/** What is happening now, for the form as a whole and by request: shown above the status of the data in use, which stays until replaced. */
	let working = $state<Record<'form' | ApiCall, Message | null>>({ form: null, monthly: null, daily: null, readings: null });
	/** The saved addresses and station, read once: the form is remade for each comparison. */
	const saved = untrack(() =>
		want === 'instant'
			? { urls: { monthly: '', daily: app.rtApi.daily, readings: app.rtApi.readings }, station: app.rtApi.station }
			: { urls: { monthly: app.histApi.url, daily: '', readings: '' }, station: app.histApi.station }
	);
	let urls = $state<Record<ApiCall, string>>(saved.urls);
	let station = $state(saved.station);
	let request = 0;

	const clear = () => (working = { form: null, monthly: null, daily: null, readings: null });

	function commit(next: FlowSlot) {
		clear();
		if (real) app.setRt(next);
		else if (api) app.setHistApiSlot(next);
		else app.setHist(next);
	}

	async function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const id = ++request;
		working.form = { level: 'info', text: 'Reading file…' };
		try {
			const next = await importFile(file, want);
			if (id === request) commit(next);
		} catch (err) {
			if (id === request) working.form = { level: 'error', text: `Could not read ${file.name}: ${(err as Error).message}` };
		}
		input.value = '';
	}

	/** One request. A response that cannot be read replaces what was in use; a failed request leaves it. */
	async function fetchCall(call: ApiCall, url: string, st: string, id: number) {
		const { from, to } = apiWindow(call, new Date());
		try {
			const res = await fetch(apiUrl(url, st, from, to), { signal: AbortSignal.timeout(apiTimeoutMs(call)) });
			const body = await res.text();
			if (id !== request) return;
			if (!res.ok) {
				working[call] = { level: 'error', text: apiHttpFailure(res.status, body) };
				return;
			}
			const next = importApi(body, st, call);
			working[call] = null;
			if (call === 'monthly') app.setHistApiSlot(next);
			else app.setRtApiSlot(call, next);
		} catch (err) {
			if (id === request) working[call] = { level: 'error', text: apiRequestFailure(err as Error, call) };
		}
	}

	async function loadApi() {
		const id = ++request;
		clear();
		const st = station.trim();
		const wanted = calls.map((c) => ({ call: c, url: urls[c].trim() }));
		if (real) app.setRtApi(wanted[0].url, wanted[1].url, st);
		else app.setHistApi(wanted[0].url, st);
		const asked = real ? wanted.filter((w) => w.url) : wanted;
		if (!asked.length) {
			working.form = { level: 'error', text: 'Enter the daily flow API address, the real-time API address, or both.' };
			return;
		}
		const problems = asked.map((w) => ({ ...w, problem: apiInputProblem(w.url, st) })).filter((w) => w.problem);
		if (problems.length) {
			for (const w of problems) working[w.call] = { level: 'error', text: w.problem };
			return;
		}
		for (const w of asked) working[w.call] = { level: 'info', text: 'Loading…' };
		// A request left out clears what an earlier one loaded, so the chart shows only what was asked for.
		for (const w of wanted) if (real && !w.url) app.setRtApiSlot(w.call as 'daily' | 'readings', { ...app.rtApiSlots[w.call as 'daily' | 'readings'], flow: null, message: null });
		await Promise.all(asked.map((w) => fetchCall(w.call, w.url, st, id)));
	}

	const setSource = (s: FlowSource) => {
		if (real) app.setRtSource(s);
		else app.setHistSource(s);
		clear();
	};
	const setSheet = (name: string) => commit(pickSheet(slot, name, want));
	const setUnit = (unitIn: FlowUnit) => commit(applyImport({ ...slot, unitIn }, want));
	const setYearIs = (yearIs: YearIs) => commit(applyImport({ ...slot, yearIs }, want));
	/** A message under its request's name when there are two requests. */
	const said = (call: ApiCall, text: string) => (real ? `${API_CALL[call].name}: ${text}` : text);
</script>

<fieldset class="sources">
	<legend>Data source</legend>
	{#each sources as s (s.value)}
		<label class="source">
			<input type="radio" name="source-{want}" value={s.value} checked={view.source === s.value} onchange={() => setSource(s.value)} />
			<span><b>{s.label}</b> <span class="muted">{s.detail}</span></span>
		</label>
	{/each}
</fieldset>

{#if view.source === 'sheet' || view.source === 'text'}
	<div class="controls">
		<label class="file">{fileLabel}
			<input type="file" {accept} onchange={onFile} />
		</label>
	</div>
{/if}

{#if api}
	<div class="notice info">
		{#if real}
			The DWS daily flow and real-time APIs are not yet established, so this form is ready for them and the response format is an
			assumption. The daily flow API is asked for the whole record, from 1900, and the real-time API for the last {API_DAYS} days.
			Either can be left blank. {'{station}'}, {'{from}'} and {'{to}'} in each address are filled in. Each response must be JSON rows
			with a time and a flow in m³/s, or CSV. The two are drawn together a month at a time, as a linked gauge is.
		{:else}
			The DWS monthly volumes API is not yet established, so this form is ready for it and the response format is an assumption.
			{'{station}'}, {'{from}'} and {'{to}'} in the address are filled in, and the request asks for the whole record, from 1900. The
			response must be JSON rows or CSV: a date and a flow for each month, or a year with month columns. Values are read as Mm³ per
			month unless a column name gives the unit; check Values are in after loading.
		{/if}
	</div>
	<div class="controls api">
		<label>Station
			<input size="10" bind:value={station} placeholder="X0H000" />
		</label>
		{#each calls as c (c)}
			<label class="address">{API_CALL[c].name}
				<input size="44" bind:value={urls[c]} placeholder={'https://…/flow?station={station}&from={from}&to={to}'} />
			</label>
		{/each}
		<button type="button" onclick={loadApi}>{real ? 'Load daily and real-time flow' : 'Load full record'}</button>
	</div>
{/if}

{#each ['form', ...calls] as const as k (k)}
	{@const w = working[k]}
	{#if w}
		<div class="notice {w.level}" role={w.level === 'error' ? 'alert' : 'status'}>{k === 'form' ? w.text : said(k, w.text)}</div>
	{/if}
{/each}
{#if real && api}
	{#each calls as c (c)}
		{@const s = app.rtApiSlots[c as 'daily' | 'readings']}
		{#if s.message}
			<div class="notice {s.message.level}" role={s.message.level === 'error' ? 'alert' : 'status'}>
				<b>{API_CALL[c].name}, {s.name}.</b> {s.message.text}
			</div>
		{/if}
	{/each}
{:else if slot.message && sheet && view.source !== 'gauge'}
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
