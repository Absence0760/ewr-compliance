<script lang="ts">
	import { resolve } from '$app/paths';
	import WmaMap from '#lib/components/map/WmaMap.svelte';
	import { WMAS, wmaOfBasin } from '#lib/components/map/wma.ts';
	import { app } from '#lib/state/app.svelte.ts';

	let hovered = $state('');
	/** EWR nodes in each WMA, by slug. */
	const counts = $derived.by(() => {
		const c = new Map<string, number>();
		for (const n of app.nodes) {
			const w = wmaOfBasin(n.basin)?.slug;
			if (w) c.set(w, (c.get(w) ?? 0) + 1);
		}
		return c;
	});
	const withData = $derived(new Set(counts.keys()));
</script>

<div class="home">
	<header class="banner">
		<h2>EWR Compliance Measurement</h2>
		<p>Choose a Water Management Area to see its EWR nodes, flow gauges, quaternary catchments and rivers.</p>
	</header>
	<section class="view split">
		<WmaMap bind:hovered {withData} />
		<nav class="panel" aria-label="Water Management Areas">
			<h3>Water Management Areas</h3>
			<ul>
				{#each WMAS as w (w.slug)}
					{@const n = counts.get(w.slug) ?? 0}
					<li>
						<a
							href={resolve(`wma/${w.slug}/` as '/')}
							class:on={hovered === w.slug}
							onmouseenter={() => (hovered = w.slug)}
							onmouseleave={() => (hovered = '')}
							onfocus={() => (hovered = w.slug)}
							onblur={() => (hovered = '')}
						>
							<b>{w.name}</b>
							<span class="muted">{n ? `${n} EWR node${n === 1 ? '' : 's'}` : 'No EWR data yet'}</span>
						</a>
					</li>
				{/each}
			</ul>
			<p class="muted note">The WMAs of 2023, from the Department of Water and Sanitation.</p>
		</nav>
	</section>
</div>

<style>
	.home {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.banner {
		padding: 18px 20px 16px;
		background: linear-gradient(90deg, #2f2152, #4b2e83);
		color: #fff;
	}
	.banner h2 {
		margin: 0;
		font-size: 24px;
		letter-spacing: 0.01em;
	}
	.banner p {
		margin: 4px 0 0;
		color: #e6e0f2;
	}
	.home .split {
		flex: 1;
		min-height: 0;
	}
	h3 {
		margin: 0 0 8px;
		font-size: 15px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	a {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 12px;
		border: 1px solid var(--line);
		border-radius: 6px;
		color: var(--ink);
		text-decoration: none;
	}
	a:hover,
	a.on {
		border-color: var(--accent);
		background: #eef4fb;
	}
	.note {
		font-size: 12px;
	}
	@media (max-width: 860px) {
		.home .split {
			flex: none;
		}
	}
</style>
