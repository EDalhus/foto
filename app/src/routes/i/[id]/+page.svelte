<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import Viewer from '$lib/components/Viewer.svelte';

	let { data } = $props();

	// Bla innenfor albumet uten å laste siden på nytt; URL-en oppdateres for hvert bilde.
	let navigated = $state<{ from: string; id: string } | null>(null);
	const currentId = $derived(navigated && navigated.from === data.photoId ? navigated.id : data.photoId);
	const index = $derived(Math.max(0, data.photos.findIndex((p) => p.id === currentId)));
	const photo = $derived(data.photos[index]);

	let favs = $derived(new Set<string>(data.favorites ?? []));
	async function toggleFavorite(id: string) {
		const on = !favs.has(id);
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
	ontogglefavorite={toggleFavorite}
	onnavigate={(id) => {
		navigated = { from: data.photoId, id };
		replaceState(`/i/${id}`, {});
	}}
	onclose={() => goto(data.album.path)}
/>
