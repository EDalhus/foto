<script lang="ts">
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CardGrid from '$lib/components/CardGrid.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import JustifiedGrid from '$lib/components/JustifiedGrid.svelte';
	import Viewer from '$lib/components/Viewer.svelte';
	import { formatDate, plural } from '$lib/format';

	let { data } = $props();

	const node = $derived(data.node);
	const openIndex = $derived(
		page.state.photoId ? data.photos.findIndex((p) => p.id === page.state.photoId) : -1
	);
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
	</header>

	{#if node.type === 'folder'}
		{#if data.cards.length}
			<CardGrid cards={data.cards} />
		{:else}
			<p class="muted">Mappa er tom.</p>
		{/if}
	{:else if data.photos.length}
		<JustifiedGrid photos={data.photos} onopen={open} />
	{:else}
		<p class="muted">Albumet er tomt.</p>
	{/if}
</div>

{#if openIndex >= 0}
	<Viewer
		photos={data.photos}
		index={openIndex}
		albumName={node.name}
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
</style>
