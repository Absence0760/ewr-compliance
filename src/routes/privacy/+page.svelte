<script lang="ts">
	import { onMount } from 'svelte';
	import { notice } from '#lib/privacy/notice.svelte.ts';
	import type { Inline } from '#lib/privacy/markdown.ts';

	onMount(() => void notice.load());
</script>

{#snippet text(content: Inline[])}
	{#each content as part, i (i)}
		{#if part.kind === 'link'}<a href={part.href} rel="noopener noreferrer">{part.text}</a>{:else if part.kind === 'strong'}<strong>{part.text}</strong>{:else}{part.text}{/if}
	{/each}
{/snippet}

<section class="view prose">
	{#if notice.error}
		<h2>Privacy notice</h2>
		<div class="notice error" role="alert">{notice.error}</div>
	{:else if !notice.blocks}
		<h2>Privacy notice</h2>
		<p class="muted" role="status">Loading…</p>
	{:else}
		{#each notice.blocks as b, i (i)}
			{#if b.kind === 'heading'}
				<svelte:element this={`h${b.level}`}>{@render text(b.content)}</svelte:element>
			{:else if b.kind === 'para'}
				<p>{@render text(b.content)}</p>
			{:else}
				<svelte:element this={b.ordered ? 'ol' : 'ul'}>
					{#each b.items as item, j (j)}
						<li>{@render text(item)}</li>
					{/each}
				</svelte:element>
			{/if}
		{/each}
	{/if}
</section>
