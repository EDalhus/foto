<script lang="ts">
	import CardGrid from '$lib/components/CardGrid.svelte';
	import CategoryCards from '$lib/components/CategoryCards.svelte';

	let { data } = $props();
	const cover = $derived(data.cards.find((c) => c.cover && !c.isPrivate)?.cover);
</script>

<svelte:head>
	<title>{data.site.title}</title>
	<meta property="og:title" content={data.site.title} />
	<meta property="og:type" content="website" />
	{#if data.site.tagline}<meta name="description" content={data.site.tagline} />{/if}
	{#if cover}<meta property="og:image" content="{data.origin}{cover.src.replace(/[smlx]\.webp$/, 'og.jpg')}" />{/if}
</svelte:head>

<div class="wrap">
	<!-- Navnet står allerede øverst i menyen; overskriften er bare for skjermlesere og søkemotorer. -->
	<h1 class="sr-only">{data.site.title}</h1>
	{#if data.site.tagline}<p class="tagline muted">{data.site.tagline}</p>{/if}
	<div class="top"></div>

	{#if data.accessExpired}
		<p class="notice warn">Tilgangen din til de delte bildene har utløpt. Ta kontakt med fotografen hvis du trenger den igjen.</p>
	{/if}

	{#if data.shared.length}
		<section class="shared" aria-labelledby="shared-h">
			<h2 id="shared-h">Delt med deg</h2>
			<CardGrid cards={data.shared} />
		</section>
		{#if data.cards.length}<h2 class="more">Alle album</h2>{/if}
	{/if}

	{#if data.grouping}
		<CategoryCards grouping={data.grouping} />
	{:else if data.cards.length}
		<CardGrid cards={data.cards} />
	{:else if !data.shared.length}
		<div class="empty">
			<p>Ingen album er publisert ennå.</p>
			{#if data.user?.isAdmin}
				<p class="muted">Lag det første albumet under <a href="/admin">Administrer</a>, eller publiser fra Lightroom.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.top {
		height: clamp(8px, 1.5vw, 20px);
	}
	.tagline {
		margin: clamp(8px, 1.5vw, 20px) 0 0;
		font-size: clamp(15px, 1.4vw, 17px);
	}
	.shared {
		display: grid;
		gap: 18px;
		margin-bottom: clamp(36px, 5vw, 64px);
	}
	h2 {
		font-size: 20px;
		letter-spacing: -0.01em;
	}
	.more {
		margin-bottom: 18px;
	}
	.empty {
		padding: 48px 0;
		color: var(--text);
		display: grid;
		gap: 8px;
	}
	.empty a {
		text-decoration: underline;
	}
</style>
