<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { app } from '#lib/state/app.svelte.ts';
	import { session } from '#lib/state/session.svelte.ts';
	import { signOut } from '#lib/users/api.ts';
	import FileViewer from '#lib/components/viewer/FileViewer.svelte';
	import DeleteNodeDialog from '#lib/components/nodes/DeleteNodeDialog.svelte';
	import { wmaBySlug } from '#lib/components/map/wma.ts';
	import type { EcBasis } from '#lib/ewr/types.ts';

	let { children } = $props();
	/** Users and Import are offered to admins only, on a host with a user list. */
	const nav = $derived([
		{ href: resolve('/'), label: 'Map and compliance' },
		{ href: resolve('nodes/'), label: 'Nodes and ECs' },
		{ href: resolve('notes/'), label: 'Method and data notes' },
		...(session.me?.admin
			? [
					{ href: resolve('users/'), label: 'Users' },
					{ href: resolve('import/'), label: 'Import' }
				]
			: [])
	]);
	const home = resolve('/');
	/** A WMA's map is part of the map, under its first link. */
	const inWma = $derived(page.url.pathname.startsWith(`${home.replace(/\/$/, '')}/wma/`));
	const here = (href: string) => page.url.pathname.replace(/\/$/, '') === href.replace(/\/$/, '') || (href === home && inWma);
	/** At the end of the bar, on every page, for everyone who can load the site. Not a footer, which would take height from the map. */
	const privacy = { href: resolve('privacy/'), label: 'Privacy notice' };
	const current = $derived([...nav, privacy].find((n) => here(n.href)));
	/** The notice needs none of the data, so it shows even when the data cannot load. */
	const onPrivacy = $derived(here(privacy.href));
	const wmaName = $derived(inWma ? wmaBySlug(page.params.wma ?? '')?.name : undefined);
	/** The home page's banner carries the title, as its h1, so the bar leaves it out there. */
	const isHome = $derived(page.url.pathname.replace(/\/$/, '') === home.replace(/\/$/, '') && !page.error);
	/** Set when the API did not confirm a sign-out: the session may still be live, so say so and stay. */
	let signOutError = $state('');
	/** Ends the session on the API, then leaves for the sign-in page, which the cookies no longer pass. */
	async function leave() {
		signOutError = '';
		try {
			await signOut();
		} catch (e) {
			signOutError = `You are still signed in: ${(e as Error).message} Try again.`;
			return;
		}
		session.signIn(true);
	}
	onMount(() => {
		void app.load();
		void session.check();
	});
</script>

<svelte:head>
	<title>{wmaName ? `${wmaName} · ` : ''}{current ? `${current.label} · ` : ''}EWR Compliance Measurement</title>
</svelte:head>

<a class="skip" href="#main">Skip to main content</a>
<header class="appbar">
	{#if !isHome}
		<h1>EWR Compliance Measurement</h1>
	{/if}
	<nav aria-label="Views">
		{#each nav as n (n.href)}
			<a href={n.href} class:on={here(n.href)} aria-current={here(n.href) ? 'page' : undefined}>{n.label}</a>
		{/each}
	</nav>
	{#if session.me}
		<span class="muted signed">Signed in as {session.me.email}</span>
		<button type="button" class="signout" onclick={leave}>Sign out</button>
		{#if signOutError}<span class="signed error" role="alert">{signOutError}</span>{/if}
	{/if}
	<label class="inline">
		EC to use
		<select value={app.ecBasis} onchange={(e) => app.setEcBasis(e.currentTarget.value as EcBasis)}>
			<option value="TEC">TEC (default)</option>
			<option value="REC">REC</option>
			<option value="PES">PES</option>
		</select>
	</label>
	<a class="privacy" href={privacy.href} aria-current={current === privacy ? 'page' : undefined}>{privacy.label}</a>
</header>

<main id="main" tabindex="-1">
	{#if onPrivacy}
		{@render children()}
	{:else if app.loadError}
		<div class="notice error" style="margin:14px">Could not start: {app.loadError}</div>
	{:else if app.loaded}
		{@render children()}
	{:else}
		<p class="muted" role="status" style="margin:14px">Loading…</p>
	{/if}
</main>
<FileViewer />
<DeleteNodeDialog />
