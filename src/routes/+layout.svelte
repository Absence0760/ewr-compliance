<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { app } from '#lib/state/app.svelte.ts';
	import FileViewer from '#lib/components/viewer/FileViewer.svelte';
	import type { EcBasis } from '#lib/ewr/types.ts';

	let { children } = $props();
	const nav = [
		{ href: resolve('/'), label: 'Map and compliance' },
		{ href: resolve('nodes/'), label: 'Nodes and ECs' },
		{ href: resolve('notes/'), label: 'Method and data notes' }
	];
	const here = (href: string) => page.url.pathname.replace(/\/$/, '') === href.replace(/\/$/, '');
	const current = $derived(nav.find((n) => here(n.href)));
	onMount(() => app.load());
</script>

<svelte:head>
	<title>{current ? `${current.label} · ` : ''}EWR Compliance Measurement</title>
</svelte:head>

<a class="skip" href="#main">Skip to main content</a>
<header class="appbar">
	<h1>EWR Compliance Measurement</h1>
	<nav aria-label="Views">
		{#each nav as n (n.href)}
			<a href={n.href} class:on={here(n.href)} aria-current={here(n.href) ? 'page' : undefined}>{n.label}</a>
		{/each}
	</nav>
	<label class="inline">
		EC to use
		<select value={app.ecBasis} onchange={(e) => app.setEcBasis(e.currentTarget.value as EcBasis)}>
			<option value="TEC">TEC (default)</option>
			<option value="REC">REC</option>
			<option value="PES">PES</option>
		</select>
	</label>
</header>

<main id="main" tabindex="-1">
	{#if app.loadError}
		<div class="notice error" style="margin:14px">Could not start: {app.loadError}</div>
	{:else if app.loaded}
		{@render children()}
	{:else}
		<p class="muted" role="status" style="margin:14px">Loading…</p>
	{/if}
</main>
<FileViewer />
