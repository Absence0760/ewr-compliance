<script lang="ts">
	import { onDestroy } from 'svelte';

	let { table }: { table: HTMLTableElement | undefined } = $props();

	let text = $state('Copy table');
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		if (!table) return;
		const rows = [...table.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()).join('\t')).join('\n');
		try {
			await navigator.clipboard.writeText(rows);
			text = 'Copied';
		} catch {
			text = 'Copy blocked';
		}
		clearTimeout(timer);
		timer = setTimeout(() => (text = 'Copy table'), 1500);
	}

	onDestroy(() => clearTimeout(timer));
</script>

<button type="button" onclick={copy}>{text}</button>
