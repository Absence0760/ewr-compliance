<!--
	The confirmation before an admin deletes a node (#17), opened from the node's popup or the compliance
	panel (app.askDelete). It names the node and says what deleting does: a built-in node is hidden from
	everyone until restored, and a node added on the site is removed. Mounted once, in the layout.
-->
<script lang="ts">
	import { app } from '#lib/state/app.svelte.ts';
	import { session } from '#lib/state/session.svelte.ts';
	import { wmaBySlug } from '#lib/components/map/wma.ts';
	import { nodeRefusal } from '#lib/users/api.ts';

	let dialog = $state<HTMLDialogElement>();
	let busy = $state(false);
	let error = $state('');

	const node = $derived(app.deleting ? (app.byId.get(app.deleting) ?? null) : null);
	const uploaded = $derived(node ? app.isUploaded(node.id) : false);
	const wmaName = $derived(node ? (wmaBySlug(app.wmaOf(node) ?? '')?.name ?? '') : '');

	$effect(() => {
		const open = !!node && !!session.me?.admin;
		if (open && !dialog?.open) {
			error = '';
			dialog?.showModal();
		} else if (!open && dialog?.open) dialog.close();
	});

	async function confirm() {
		if (!node || busy) return;
		const { id, label } = node;
		busy = true;
		error = '';
		try {
			await app.deleteNode(id);
			app.nodeStoreDone = uploaded ? `Deleted ${label}.` : `Deleted ${label}. It is listed under Deleted nodes, to restore.`;
			app.deleting = null;
		} catch (e) {
			error = nodeRefusal(e);
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} aria-labelledby="delete-node-title" onclose={() => { if (!dialog?.open) app.deleting = null; }}>
	{#if node}
		<h2 id="delete-node-title">Delete node {node.label}?</h2>
		{#if uploaded}
			<p>{node.label} was added on the site. Deleting it removes it and its files for everyone. To bring it back, add it again.</p>
		{:else}
			<p>
				{node.label} is a built-in node. Deleting it hides it from everyone, on the map and in Nodes and ECs, until an admin
				restores it from Deleted nodes on the {wmaName || 'WMA'} map.
			</p>
		{/if}
		{#if error}<div class="notice error" role="alert">{error}</div>{/if}
		<div class="actions">
			<button type="button" class="danger" disabled={busy} onclick={confirm}>{busy ? 'Deleting…' : `Delete ${node.label}`}</button>
			<button type="button" disabled={busy} onclick={() => dialog?.close()}>Cancel</button>
		</div>
	{/if}
</dialog>

<style>
	dialog {
		width: min(460px, 94vw);
		padding: 16px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	h2 {
		margin: 0 0 8px;
	}
	p {
		margin: 0 0 10px;
		line-height: 1.45;
	}
	.actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.danger {
		background: var(--critical);
		border-color: var(--critical);
		color: #fff;
		font-weight: 600;
	}
	.danger:hover {
		filter: brightness(0.88);
	}
</style>
