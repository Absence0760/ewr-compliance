<!--
	A window for loading observed flow from a file: monthly or daily flow for the Historical Comparison,
	and 12-minute readings for the Real Time Comparison. Each file is chosen or dropped, read in the
	browser by the same importer as each comparison's own Data source, and put in use there. The file
	never leaves the browser. Sheet, units and year are set in the comparison afterwards.
-->
<script lang="ts">
	import { importFile, looksLikeBook } from '#lib/ewr/importFlow.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { FlowWant, HistStep } from '#lib/ewr/types.ts';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const ACCEPT = '.xlsx,.xlsm,.xlsb,.xls,.ods,.txt,.csv,.tsv,.dat,.prn,.mrv,.mon,.day';
	const KINDS: { want: FlowWant; step: HistStep | null; title: string; tabName: string; what: string; note?: string }[] = [
		{
			want: 'monthly',
			step: 'monthly',
			title: 'Monthly flow',
			tabName: 'Historical Comparison',
			what: 'A DWS monthly file (.mon), or a spreadsheet or text table of monthly volumes or flows.'
		},
		{
			want: 'daily',
			step: 'daily',
			title: 'Daily flow',
			tabName: 'Historical Comparison',
			what: 'A DWS daily file (.day), or a spreadsheet or text table of dated daily flows in m³/s.'
		},
		{
			want: 'instant',
			step: null,
			title: '12-minute readings',
			tabName: 'Real Time Comparison',
			what: 'A spreadsheet or text table of dated 12-minute readings in m³/s, such as telemetry.',
			note: 'DWS publishes 12-minute readings for about the last month only, until its hydrologists verify them into daily flow. For earlier months, load a daily file for the Historical Comparison.'
		}
	];

	let dialog = $state<HTMLDialogElement>();
	/** Reading, or a file that could not be read, for each kind. A file read is reported from the app's own slot. */
	let working = $state<Record<FlowWant, { level: 'info' | 'error'; text: string } | null>>({ monthly: null, daily: null, instant: null });
	let over = $state<FlowWant | null>(null);
	const request: Record<FlowWant, number> = { monthly: 0, daily: 0, instant: 0 };

	$effect(() => {
		if (open && !dialog?.open) dialog?.showModal();
		else if (!open && dialog?.open) dialog.close();
	});

	const slotOf = (want: FlowWant) => (want === 'monthly' ? app.hist : want === 'daily' ? app.day : app.rt);
	const viewOf = (want: FlowWant) => (want === 'monthly' ? app.histView : want === 'daily' ? app.dayView : app.rtView);
	/** A file is reported only while it is what the comparison uses, not a gauge or the DWS store. */
	const fileInUse = (want: FlowWant) => ['sheet', 'text'].includes(viewOf(want).source);

	/** Read the file, put it in use in its comparison in place of a gauge or the DWS store, and say how it went. */
	async function load(want: FlowWant, file: File | undefined) {
		if (!file) return;
		const id = ++request[want];
		working[want] = { level: 'info', text: `Reading ${file.name}…` };
		try {
			const slot = await importFile(file, want);
			if (id !== request[want]) return;
			const source = looksLikeBook(file.name) ? 'sheet' : 'text';
			if (want === 'monthly') {
				app.setHist(slot);
				app.setHistSource(source);
			} else if (want === 'daily') {
				app.setDay(slot);
				app.setDaySource(source);
			} else {
				app.setRt(slot);
				app.setRtSource(source);
			}
			working[want] = null;
		} catch (err) {
			if (id === request[want]) working[want] = { level: 'error', text: `Could not read ${file.name}: ${(err as Error).message}` };
		}
	}

	function onPick(want: FlowWant, e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		void load(want, input.files?.[0]);
		input.value = '';
	}

	function onDrop(want: FlowWant, e: DragEvent) {
		e.preventDefault();
		over = null;
		void load(want, e.dataTransfer?.files[0]);
	}

	/** Go to where the file is in use: one of the Historical Comparison's views, or the Real Time Comparison. */
	function show(step: HistStep | null) {
		if (step) app.showHist(step);
		else app.tab = 'rt';
		dialog?.close();
	}
</script>

<!-- close fires for the Close button and for Esc, so both clear `open`. -->
<dialog bind:this={dialog} aria-labelledby="load-flow-title" onclose={() => (open = false)}>
	<div class="head">
		<h2 id="load-flow-title">Load flow data</h2>
		<button type="button" onclick={() => dialog?.close()}>Close</button>
	</div>
	<p class="muted intro">
		Load observed flow from a file, as well as or instead of a linked gauge or the DWS store. The file is read in this browser and is
		not sent anywhere. It stays in use as you move between nodes.
	</p>
	{#each KINDS as k (k.want)}
		{@const slot = slotOf(k.want)}
		{@const w = working[k.want]}
		<section aria-labelledby="load-{k.want}">
			<h3 id="load-{k.want}">{k.title} <span class="muted">for the {k.tabName}</span></h3>
			<p class="muted">{k.what}</p>
			{#if k.note}<p class="muted">{k.note}</p>{/if}
			<div
				class="drop"
				class:over={over === k.want}
				role="group"
				aria-label="{k.title} file"
				ondragover={(e) => {
					e.preventDefault();
					over = k.want;
				}}
				ondragleave={() => (over = null)}
				ondrop={(e) => onDrop(k.want, e)}
			>
				<label class="file">
					Choose a {k.title.toLowerCase()} file
					<input type="file" accept={ACCEPT} onchange={(e) => onPick(k.want, e)} />
				</label>
				<span class="muted">or drop it here</span>
			</div>
			{#if w}
				<div class="notice {w.level}" role={w.level === 'error' ? 'alert' : 'status'}>{w.text}</div>
			{:else if slot.message && slot.name && fileInUse(k.want)}
				<div class="notice {slot.message.level}" role={slot.message.level === 'error' ? 'alert' : 'status'}>
					<b>{slot.name}.</b> {slot.message.text}
				</div>
				{#if slot.flow}
					<button type="button" onclick={() => show(k.step)}>Show {k.title.toLowerCase()} in the {k.tabName}</button>
				{/if}
			{/if}
		</section>
	{/each}
</dialog>

<style>
	dialog {
		width: min(640px, 94vw);
		max-height: 90vh;
		padding: 0 16px 16px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.head {
		position: sticky;
		top: 0;
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
	.intro {
		margin: 10px 0 4px;
	}
	section {
		margin-top: 14px;
	}
	h3 {
		margin: 0;
		font-size: 15px;
	}
	h3 .muted {
		font-weight: 400;
		font-size: 13px;
	}
	section > p {
		margin: 2px 0 8px;
	}
	.drop {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px;
		border: 2px dashed #b9b8b0;
		border-radius: 8px;
		background: var(--surface-2);
	}
	.drop.over {
		border-color: var(--accent);
		background: #eef4fb;
	}
	section > button {
		margin-top: 4px;
	}
</style>
