<script lang="ts">
	// The factor on a node's gauge record. One for the node, whichever comparison it is typed in.
	import { parseFactor } from '#lib/ewr/parsers.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import type { GaugeLink } from '#lib/ewr/types.ts';

	let { link }: { link: GaugeLink } = $props();

	let bad = $state('');

	/** Clearing the box goes back to the link's own factor. */
	function setFactor(el: HTMLInputElement) {
		const typed = parseFactor(el.value);
		bad = typed === null && el.value.trim() ? `${el.value} is not a factor. It must be a number above 0.` : '';
		if (bad) return;
		app.choose(link.node, { factor: typed ?? undefined });
		el.value = String(app.factor);
	}
</script>

<div class="controls">
	<label>Factor on the gauge record
		<input type="number" min="0" step="any" value={app.factor} onchange={(e) => setFactor(e.currentTarget)} />
	</label>
	{#if link.note}<span class="muted">{link.note}</span>{/if}
</div>
{#if bad}<div class="notice error" role="alert">{bad}</div>{/if}
