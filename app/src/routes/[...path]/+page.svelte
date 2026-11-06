<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CardGrid from '$lib/components/CardGrid.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Gallery from '$lib/components/Gallery.svelte';
	import { formatDate, formatLocal, plural } from '$lib/format';
	import { submit } from '$lib/submit';
	import { toast } from '$lib/toasts.svelte';

	let { data } = $props();

	const node = $derived(data.node);

	// Statistikk: én melding når mappa/albumet faktisk vises (serveren teller samme besøkende én gang per halvtime).
	$effect(() => {
		const id = node.id;
		if (data.isAdmin) return;
		fetch('/api/v1/stats/view', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: id }) }).catch(
			() => {}
		);
	});

	// --- Favoritter (kunden velger bilder) ---
	// Følger serverens liste, men kan endres lokalt med en gang (hjertet reagerer før svaret kommer).
	let favs = $derived(new Set<string>(data.favorites?.ids ?? []));
	let onlyFavs = $state(false);
	const favorites = $derived(data.favorites ? favs : null);

	// --- Sortering (husket i adressen, så lenken kan deles) ---
	type Sort = 'album' | 'eldste' | 'nyeste';
	const SORTS: { id: Sort; label: string }[] = [
		{ id: 'album', label: 'Albumets rekkefølge' },
		{ id: 'eldste', label: 'Eldste først' },
		{ id: 'nyeste', label: 'Nyeste først' }
	];
	const sort = $derived.by<Sort>(() => {
		const v = page.url.searchParams.get('sortering');
		return v === 'eldste' || v === 'nyeste' ? v : 'album';
	});
	const sorted = $derived.by(() => {
		if (sort === 'album') return data.photos;
		const dir = sort === 'eldste' ? 1 : -1;
		// Bilder uten dato havner sist; ellers beholdes albumets rekkefølge ved likhet.
		return data.photos
			.map((p, i) => ({ p, i }))
			.sort((a, b) => {
				const x = a.p.takenAt;
				const y = b.p.takenAt;
				if (x == null || y == null) return x == null && y == null ? a.i - b.i : x == null ? 1 : -1;
				return (x - y) * dir || a.i - b.i;
			})
			.map((x) => x.p);
	});
	let sortOpen = $state(false);
	function setSort(id: Sort) {
		sortOpen = false;
		const url = new URL(page.url);
		if (id === 'album') url.searchParams.delete('sortering');
		else url.searchParams.set('sortering', id);
		goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
	}

	const shown = $derived(onlyFavs && favorites ? sorted.filter((p) => favs.has(p.id)) : sorted);
	// «Velg N bilder» og låst valg (etter at det er sendt).
	const locked = $derived(!!data.favorites?.lockedAt);
	const target = $derived(data.favorites?.target ?? null);
	const full = $derived(!!target && favs.size >= target);
	let confirmSend = $state(false);

	// --- Forsidebilde fra bildevisningen (bare for administratoren) ---
	// Gjelder bare albumet det ble valgt i (siden gjenbrukes når man går til et annet album).
	let coverPick = $state<{ album: string; id: string } | null>(null);
	const coverOverride = $derived(coverPick?.album === node.id ? coverPick.id : null);
	async function setCover(id: string) {
		const before = coverPick;
		coverPick = { album: node.id, id };
		const res = await fetch(`/api/v1/albums/${node.id}/cover`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ photo: id })
		}).catch(() => null);
		if (res?.ok) toast('Forsidebildet er byttet.');
		else {
			coverPick = before;
			toast('Klarte ikke å bytte forsidebilde.', 'error');
		}
	}

	async function toggleFavorite(id: string) {
		const on = !favs.has(id);
		if (locked) {
			toast('Valget er sendt og låst. Ta kontakt med fotografen hvis du vil endre det.', 'info');
			return;
		}
		if (on && target && favs.size >= target) {
			toast(`Du har valgt ${favs.size} av ${target}. Fjern et bilde før du velger et nytt.`, 'info');
			return;
		}
		const next = new Set(favs);
		if (on) next.add(id);
		else next.delete(id);
		favs = next;
		confirmSend = false;
		try {
			const res = await fetch('/api/v1/favorites', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ photo: id, on })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				if (res.status === 423) invalidateAll();
				throw new Error(body?.error ?? '');
			}
		} catch (err) {
			const back = new Set(favs);
			if (on) back.delete(id);
			else back.add(id);
			favs = back;
			toast((err as Error).message || 'Klarte ikke å lagre favoritten. Sjekk nettet og prøv igjen.', 'error');
		}
	}
	$effect(() => {
		if (onlyFavs && favs.size === 0) onlyFavs = false;
	});

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

<svelte:window onkeydown={(e) => e.key === 'Escape' && sortOpen && (sortOpen = false)} />

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
			{#if node.type === 'album' && data.photos.length > 1}
				<div class="sort">
					<button
						class="sort-btn"
						type="button"
						aria-haspopup="menu"
						aria-expanded={sortOpen}
						onclick={() => (sortOpen = !sortOpen)}
					>
						<Icon name="order" size={18} />
						{SORTS.find((s) => s.id === sort)?.label}
					</button>
					{#if sortOpen}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<div class="sort-scrim" onclick={() => (sortOpen = false)}></div>
						<div class="sort-menu" role="menu">
							{#each SORTS as s (s.id)}
								<button type="button" role="menuitemradio" aria-checked={s.id === sort} onclick={() => setSort(s.id)}>
									<span class="tick">{#if s.id === sort}<Icon name="check" size={15} />{/if}</span>
									{s.label}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if data.favorites}
			<div class="picks" class:locked aria-live="polite">
				<div class="picks-text">
					{#if locked}
						<span class="done"><Icon name="check" size={16} /></span>
						<strong>Valget er sendt</strong>
						<span>{plural(favs.size, 'bilde', 'bilder')} · {formatLocal(data.favorites.lockedAt)}. Ta kontakt med fotografen hvis du vil endre det.</span>
					{:else if target}
						<Icon name="heart" size={16} filled={favs.size > 0} />
						<strong>{favs.size} av {target} valgt</strong>
						<span class="meter" class:full role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={favs.size} aria-label="Valgt"
							><i style:width="{Math.min(100, (favs.size / target) * 100)}%"></i></span
						>
						{#if favs.size === 0}
							<span>Trykk på hjertet på de {target} bildene du vil ha.</span>
						{:else if full}
							<span>Alle er valgt – send valget når du er klar.</span>
						{/if}
					{:else if favs.size}
						<Icon name="heart" size={16} filled />
						<strong>{plural(favs.size, 'favoritt', 'favoritter')}</strong>
						{#if data.favorites.submittedAt}<span class="faint">· sendt {formatLocal(data.favorites.submittedAt)}</span>{/if}
					{:else}
						<Icon name="heart" size={16} />
						<span>Trykk på hjertet på bildene du liker, og send valget når du er ferdig.</span>
					{/if}
				</div>
				{#if favs.size}
					<div class="picks-actions">
						<button class="btn ghost" type="button" onclick={() => (onlyFavs = !onlyFavs)} aria-pressed={onlyFavs}>
							{onlyFavs ? 'Vis alle bildene' : 'Vis bare valgte'}
						</button>
						{#if !locked}
							{#if confirmSend}
								<form method="POST" action="?/sendFavorites" class="confirm" use:enhance={submit({ onsuccess: () => (confirmSend = false) })}>
									<span>Du har valgt {favs.size} av {target}. Sende likevel?</span>
									<button class="btn primary" type="submit"><Icon name="send" size={16} /> Send likevel</button>
									<button class="btn ghost" type="button" onclick={() => (confirmSend = false)}>Velg flere</button>
								</form>
							{:else if target && favs.size < target}
								<button class="btn primary" type="button" onclick={() => (confirmSend = true)}><Icon name="send" size={16} /> Send valget</button>
							{:else}
								<form method="POST" action="?/sendFavorites" use:enhance={submit()}>
									<button class="btn primary" type="submit"><Icon name="send" size={16} /> {data.favorites.submittedAt ? 'Send valget på nytt' : 'Send valget'}</button>
								</form>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</header>

	{#if node.type === 'folder'}
		{#if data.cards.length}
			<CardGrid cards={data.cards} />
		{:else}
			<p class="muted">Mappa er tom.</p>
		{/if}
	{:else if data.photos.length}
		<Gallery
			photos={shown}
			albumName={node.name}
			{favorites}
			favoritesLocked={locked}
			ontogglefavorite={toggleFavorite}
			coverId={data.isAdmin ? (coverOverride ?? data.coverId) : null}
			onsetcover={data.isAdmin ? setCover : undefined}
		/>
	{:else}
		<p class="muted">Albumet er tomt.</p>
	{/if}
</div>


<style>
	.head {
		padding: clamp(24px, 4vw, 56px) 0 clamp(24px, 3vw, 40px);
		display: grid;
		gap: 12px;
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
	.sort {
		position: relative;
		margin-left: auto;
		align-self: center;
	}
	.sort-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 15px;
		cursor: pointer;
	}
	.sort-btn:hover,
	.sort-btn[aria-expanded='true'] {
		color: var(--text);
	}
	.sort-scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
	}
	.sort-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 41;
		min-width: 210px;
		padding: 6px;
		display: grid;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
	}
	.sort-menu button {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 10px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 14px;
		text-align: left;
		cursor: pointer;
	}
	.sort-menu button:hover {
		background: var(--surface-2);
	}
	.tick {
		width: 15px;
		display: inline-grid;
		color: var(--muted);
	}
	.picks {
		max-width: 980px;
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
	.picks.locked {
		border-color: rgba(99, 210, 151, 0.35);
	}
	.done {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		background: rgba(99, 210, 151, 0.16);
		color: var(--ok);
	}
	.picks-text .done :global(svg) {
		color: var(--ok);
	}
	.meter {
		position: relative;
		display: inline-block;
		width: 96px;
		height: 6px;
		border-radius: 999px;
		background: var(--surface-3);
		overflow: hidden;
	}
	.meter i {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: #ff6b81;
		transition: width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.meter.full i {
		background: var(--ok);
	}
	.confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.confirm span {
		color: var(--muted);
		font-size: 14px;
	}
</style>
