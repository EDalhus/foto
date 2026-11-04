<script lang="ts">
	import { enhance } from '$app/forms';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CardGrid from '$lib/components/CardGrid.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import JustifiedGrid from '$lib/components/JustifiedGrid.svelte';
	import Viewer from '$lib/components/Viewer.svelte';
	import { formatDate, formatLocal, plural } from '$lib/format';

	let { data, form } = $props();

	const node = $derived(data.node);

	// --- Favoritter (kunden velger bilder) ---
	// Følger serverens liste, men kan endres lokalt med en gang (hjertet reagerer før svaret kommer).
	let favs = $derived(new Set<string>(data.favorites?.ids ?? []));
	let onlyFavs = $state(false);
	const favorites = $derived(data.favorites ? favs : null);
	const shown = $derived(onlyFavs && favorites ? data.photos.filter((p) => favs.has(p.id)) : data.photos);
	let favError = $state('');

	async function toggleFavorite(id: string) {
		const on = !favs.has(id);
		const next = new Set(favs);
		if (on) next.add(id);
		else next.delete(id);
		favs = next;
		favError = '';
		try {
			const res = await fetch('/api/v1/favorites', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ photo: id, on })
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			const back = new Set(favs);
			if (on) back.delete(id);
			else back.add(id);
			favs = back;
			favError = 'Klarte ikke å lagre favoritten. Sjekk nettet og prøv igjen.';
		}
	}
	$effect(() => {
		if (onlyFavs && favs.size === 0) onlyFavs = false;
	});

	const openIndex = $derived(page.state.photoId ? shown.findIndex((p) => p.id === page.state.photoId) : -1);
	const ogImage = $derived(
		node.type === 'album' ? data.photos[0]?.og : data.cards.find((c) => c.cover)?.cover?.src.replace(/[smlx]\.webp$/, 'og.jpg')
	);
	const dateText = $derived.by(() => {
		const r = data.range;
		if (!r) return '';
		const a = formatDate(r.from);
		const b = formatDate(r.to);
		return a === b ? a : `${a} – ${b}`;
	});

	function open(id: string, e: MouseEvent) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		e.preventDefault();
		pushState(`/i/${id}`, { photoId: id });
	}

	let copied = $state(false);
	async function share() {
		const url = `${data.origin}${node.path}`;
		try {
			if (navigator.share && matchMedia('(pointer: coarse)').matches) {
				await navigator.share({ title: node.name, url });
				return;
			}
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// avbrutt
		}
	}
</script>

<svelte:head>
	<title>{node.name} – {data.site.title}</title>
	<meta property="og:title" content={node.name} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="{data.origin}{node.path}" />
	{#if node.description}<meta name="description" content={node.description} />{/if}
	{#if ogImage && !node.isPrivate}<meta property="og:image" content="{data.origin}{ogImage}" />{/if}
	{#if node.isPrivate}<meta name="robots" content="noindex" />{/if}
</svelte:head>

<div class="wrap">
	<header class="head">
		<Breadcrumbs crumbs={data.crumbs} />
		<h1>{node.name}</h1>
		<div class="meta">
			{#if node.type === 'album'}
				<span>{plural(node.photoCount, 'bilde', 'bilder')}</span>
				{#if dateText}<span class="dot">·</span><span>{dateText}</span>{/if}
			{:else}
				<span>{plural(node.albumCount, 'album', 'album')}</span>
			{/if}
			{#if node.isPrivate}<span class="badge private"><Icon name="lock" size={12} /> Privat</span>{/if}
		</div>
		{#if node.description}<p class="desc">{node.description}</p>{/if}
		<div class="actions">
			{#if data.downloadAll}
				<a class="btn primary" href={data.downloadAll} download><Icon name="download" /> Last ned alle</a>
			{/if}
			<button class="btn" onclick={share}><Icon name={copied ? 'check' : 'link'} /> {copied ? 'Lenke kopiert' : 'Del'}</button>
			{#if data.isAdmin}
				<a class="btn ghost" href="/admin/node/{node.id}">Rediger</a>
			{/if}
		</div>

		{#if data.favorites}
			<div class="picks" aria-live="polite">
				<div class="picks-text">
					<Icon name="heart" size={16} filled={favs.size > 0} />
					{#if favs.size}
						<strong>{plural(favs.size, 'favoritt', 'favoritter')}</strong>
						{#if data.favorites.submittedAt}<span class="faint">· sendt {formatLocal(data.favorites.submittedAt)}</span>{/if}
					{:else}
						<span>Trykk på hjertet på bildene du liker, og send valget når du er ferdig.</span>
					{/if}
				</div>
				{#if favs.size}
					<div class="picks-actions">
						<button class="btn ghost" type="button" onclick={() => (onlyFavs = !onlyFavs)} aria-pressed={onlyFavs}>
							{onlyFavs ? 'Vis alle bildene' : 'Vis bare favorittene'}
						</button>
						<form method="POST" action="?/sendFavorites" use:enhance={() => async ({ update }) => update({ reset: false })}>
							<button class="btn primary" type="submit"><Icon name="send" size={16} /> {data.favorites.submittedAt ? 'Send valget på nytt' : 'Send valget'}</button>
						</form>
					</div>
				{/if}
			</div>
			{#if favError}<p class="notice error" role="alert">{favError}</p>{/if}
			{#if form && 'error' in form && form.error}<p class="notice error" role="alert">{form.error}</p>{/if}
			{#if form && 'sent' in form && form.sent}
				<p class="notice success" role="status">Takk! Valget ditt ({plural(form.sent, 'bilde', 'bilder')}) er sendt. Du kan fortsatt endre det og sende på nytt.</p>
			{/if}
		{/if}
	</header>

	{#if node.type === 'folder'}
		{#if data.cards.length}
			<CardGrid cards={data.cards} />
		{:else}
			<p class="muted">Mappa er tom.</p>
		{/if}
	{:else if data.photos.length}
		<JustifiedGrid photos={shown} onopen={open} {favorites} ontogglefavorite={toggleFavorite} />
	{:else}
		<p class="muted">Albumet er tomt.</p>
	{/if}
</div>

{#if openIndex >= 0}
	<Viewer
		photos={shown}
		index={openIndex}
		albumName={node.name}
		{favorites}
		ontogglefavorite={toggleFavorite}
		onnavigate={(id) => replaceState(`/i/${id}`, { photoId: id })}
		onclose={() => history.back()}
	/>
{/if}

<style>
	.head {
		padding: clamp(24px, 4vw, 56px) 0 clamp(24px, 3vw, 40px);
		display: grid;
		gap: 12px;
		max-width: 980px;
	}
	h1 {
		font-size: clamp(30px, 4.4vw, 52px);
		letter-spacing: -0.03em;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 15px;
	}
	.dot {
		color: var(--faint);
	}
	.desc {
		color: var(--muted);
		white-space: pre-line;
		max-width: 70ch;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}
	.picks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 10px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.picks-text {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		color: var(--muted);
	}
	.picks-text :global(svg) {
		color: #ff6b81;
	}
	.picks-text strong {
		color: var(--text);
	}
	.picks-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.picks-actions form {
		margin: 0;
	}
</style>
