<script lang="ts">
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import CardGrid from '$lib/components/CardGrid.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import JustifiedGrid from '$lib/components/JustifiedGrid.svelte';
	import Viewer from '$lib/components/Viewer.svelte';
	import { plural } from '$lib/format';

	let { data } = $props();

	const openIndex = $derived(page.state.photoId ? data.photos.findIndex((p) => p.id === page.state.photoId) : -1);

	function open(id: string, e: MouseEvent) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		e.preventDefault();
		pushState(`/i/${id}`, { photoId: id });
	}
</script>

<svelte:head>
	<title>{data.q ? `«${data.q}» – Søk` : 'Søk'} – {data.site.title}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap">
	<header class="head">
		<h1>Søk</h1>
		<form method="GET" action="/sok" class="searchbar" role="search">
			<Icon name="search" size={18} />
			<input
				class="input"
				type="search"
				name="q"
				value={data.q}
				placeholder="Sted, person, stikkord …"
				aria-label="Søk i bildene"
				autocomplete="off"
				enterkeyhint="search"
			/>
			<button class="btn primary" type="submit">Søk</button>
		</form>
		{#if data.q}
			<p class="muted">
				{#if data.cards.length || data.photos.length}
					{plural(data.photos.length, 'bilde', 'bilder')}{data.more ? '+' : ''}{data.cards.length ? ` og ${plural(data.cards.length, 'album eller mappe', 'album og mapper')}` : ''}
				{:else}
					Fant ingenting for «{data.q}». Prøv et annet ord.
				{/if}
			</p>
		{:else}
			<p class="muted">Søk i titler, bildetekster og stikkord fra Lightroom, og i navnene på album og mapper.</p>
		{/if}
	</header>

	{#if data.cards.length}
		<section class="block">
			<h2>Album og mapper</h2>
			<CardGrid cards={data.cards} />
		</section>
	{/if}
	{#if data.photos.length}
		<section class="block">
			{#if data.cards.length}<h2>Bilder</h2>{/if}
			<JustifiedGrid photos={data.photos} onopen={open} />
			{#if data.more}<p class="muted more">Viser de {data.photos.length} nyeste. Legg til flere ord for å snevre inn søket.</p>{/if}
		</section>
	{/if}
</div>

{#if openIndex >= 0}
	<Viewer
		photos={data.photos}
		index={openIndex}
		onnavigate={(id) => replaceState(`/i/${id}`, { photoId: id })}
		onclose={() => history.back()}
	/>
{/if}

<style>
	.head {
		padding: clamp(24px, 4vw, 56px) 0 clamp(20px, 3vw, 32px);
		display: grid;
		gap: 14px;
		max-width: 760px;
	}
	h1 {
		font-size: clamp(30px, 4.4vw, 52px);
		letter-spacing: -0.03em;
	}
	.searchbar {
		display: flex;
		align-items: center;
		gap: 10px;
		position: relative;
	}
	.searchbar :global(svg) {
		position: absolute;
		left: 12px;
		color: var(--faint);
		pointer-events: none;
	}
	.searchbar .input {
		flex: 1;
		min-width: 0;
		padding-left: 38px;
	}
	.block {
		display: grid;
		gap: 16px;
		margin-bottom: 40px;
	}
	h2 {
		font-size: 19px;
	}
	.more {
		margin-top: 8px;
	}
</style>
