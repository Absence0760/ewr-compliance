<script lang="ts">
	import { KIND_LABEL } from '#lib/ewr/format.ts';
	import { app } from '#lib/state/app.svelte.ts';

	let dialog = $state<HTMLDialogElement>();
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let text = $state('');
	let copyLabel = $state('Copy');

	const node = $derived(app.viewer ? (app.byId.get(app.viewer.nodeId) ?? null) : null);
	const files = $derived(node ? app.filesOf(node) : []);
	const file = $derived(files.find((f) => f.name === app.viewer?.file) ?? null);

	$effect(() => {
		if (node && !dialog?.open) dialog?.showModal();
		else if (!node && dialog?.open) dialog.close();
	});

	$effect(() => {
		const n = node;
		const f = file;
		if (!n) return;
		// Clearing first means a slow load shows "Loading", never the previous file.
		text = '';
		status = 'loading';
		let current = true;
		(async () => {
			if (!f) throw new Error('This file is not listed for the node.');
			const body = await app.fileText(n, f);
			if (body === undefined) throw new Error('The text of this file is missing from the data.');
			return body;
		})().then(
			(body) => {
				if (!current) return;
				text = body;
				status = 'ready';
			},
			(e: Error) => {
				if (!current) return;
				text = e.message;
				status = 'error';
			}
		);
		return () => {
			current = false;
		};
	});

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copyLabel = 'Copied';
		} catch {
			copyLabel = 'Copy blocked';
		}
		setTimeout(() => (copyLabel = 'Copy'), 1500);
	}
</script>

<!-- close fires for the Close button and for Esc, so both clear app.viewer. -->
<dialog bind:this={dialog} aria-label={node ? `Files for ${node.label}` : 'File viewer'} onclose={() => (app.viewer = null)}>
	{#if node}
		<div class="head">
			<b>{node.label}</b>
			<select aria-label="File" value={app.viewer?.file} onchange={(e) => app.openFile(node.id, e.currentTarget.value)}>
				{#each files as f ((f.uploaded ? 'uploaded:' : '') + f.name)}
					<option value={f.name}>{f.name}{f.ec ? ` (EC ${f.ec})` : ''} - {KIND_LABEL[f.kind]}</option>
				{/each}
			</select>
			<button type="button" disabled={status !== 'ready'} onclick={copy}>{copyLabel}</button>
			<button type="button" onclick={() => dialog?.close()}>Close</button>
		</div>
		{#if status === 'error'}
			<div class="notice error" role="alert">Could not load this file: {text}</div>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<!-- Focusable so the keyboard can scroll a long file. -->
			<pre tabindex="0" aria-label="File text" aria-busy={status === 'loading'}>{status === 'loading' ? 'Loading…' : text}</pre>
		{/if}
	{/if}
</dialog>

<style>
	dialog {
		width: min(1000px, 94vw);
		height: 84vh;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	dialog[open] {
		display: flex;
		flex-direction: column;
	}
	.head {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 8px;
		border-bottom: 1px solid var(--line);
	}
	.head select {
		flex: 1;
		min-width: 0;
	}
	.notice {
		margin: 8px;
	}
	pre {
		flex: 1;
		margin: 0;
		padding: 10px;
		overflow: auto;
		font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace;
	}
</style>
