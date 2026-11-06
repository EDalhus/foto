<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import Viewer from '$lib/components/Viewer.svelte';
	import { toast } from '$lib/toasts.svelte';

	let { data } = $props();

	// Bla innenfor albumet uten å laste siden på nytt; URL-en oppdateres for hvert bilde.
	let navigated = $state<{ from: string; id: string } | null>(null);
	const currentId = $derived(navigated && navigated.from === data.photoId ? navigated.id : data.photoId);
	const index = $derived(Math.max(0, data.photos.findIndex((p) => p.id === currentId)));
	const photo = $derived(data.photos[index]);

	onMount(() => {
		if (data.user?.isAdmin) return;
		fetch('/api/v1/stats/view', {
			method: 'POST',
			keepalive: true,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ node: data.album.id })
		}).catch(() => {});
	});

	let favs = $derived(new Set<string>(data.favorites ?? []));
	async function toggleFavorite(id: string) {
		const on = !favs.has(id);
		if (data.favoritesLocked) return;
		if (on && data.pickTarget && favs.size >= data.pickTarget) {
			toast(`Du har valgt ${favs.size} av ${data.pickTarget}. Fjern et bilde før du velger et nytt.`, 'info');
			return;
		}
		const next = new Set(favs);
		if (on) next.add(id);
		else next.delete(id);
		favs = next;
		const res = await fetch('/api/v1/favorites', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ photo: id, on })
		}).catch(() => null);
		if (!res?.ok) {
			const back = new Set(favs);
			if (on) back.delete(id);
			else back.add(id);
			favs = back;
			const body = await res?.json().catch(() => null);
			toast(body?.error || 'Klarte ikke å lagre favoritten.', 'error');
		}
	}
</script>

<svelte:head>
	<title>{photo?.title || data.album.name} – {data.site.title}</title>
	<meta property="og:title" content={photo?.title || data.album.name} />
	<meta property="og:type" content="article" />
	{#if photo && !data.album.isPrivate}<meta property="og:image" content="{data.origin}{photo.og}" />{/if}
	{#if photo?.caption}<meta name="description" content={photo.caption} />{/if}
	{#if data.album.isPrivate}<meta name="robots" content="noindex" />{/if}
</svelte:head>

<Viewer
	photos={data.photos}
	{index}
	albumName={data.album.name}
	favorites={data.favorites ? favs : null}
	favoritesLocked={data.favoritesLocked}
	ontogglefavorite={toggleFavorite}
	onnavigate={(id) => {
		navigated = { from: data.photoId, id };
		replaceState(`/i/${id}`, {});
	}}
	handoff
	onclose={(info) =>
		goto(data.album.path, { noScroll: true, state: { landing: { ...info, at: Date.now() } } })}
/>
