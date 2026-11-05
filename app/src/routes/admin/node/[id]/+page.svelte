<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import AccessPanel from '$lib/components/AccessPanel.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CoverPicker from '$lib/components/CoverPicker.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Uploader from '$lib/components/Uploader.svelte';
	import { formatBytes, formatDate, formatLocal, plural } from '$lib/format';
	import { submit } from '$lib/submit';
	import { toast } from '$lib/toasts.svelte';

	let { data } = $props();
	const node = $derived(data.node);
	const isAlbum = $derived(node.type === 'album');
	const it = $derived(isAlbum ? 'albumet' : 'mappa');
	const mode = $derived(data.access.mode);
	const clientNames = $derived(data.access.groups.filter((g) => g.shared && g.kind === 'client').map((g) => g.name));

	// Smale skjermer: bilder og innstillinger i hver sin fane.
	let tab = $state<'main' | 'settings'>('main');
	let picker = $state(false);
	let confirmDelete = $state(false);
	let confirmPhotos = $state(false);
	let showCreate = $state<'album' | 'folder' | null>(null);
	let target = $state('');

	// --- «Om albumet»: lagres med knappen. Ulagrede endringer overlever at resten av siden oppdateres. ---
	let name = $state(untrack(() => data.node.name));
	let description = $state(untrack(() => data.node.description));
	let parentId = $state(untrack(() => data.node.parentId ?? ''));
	let syncedFor = untrack(() => data.node.id);
	const dirty = $derived(name !== node.name || description !== node.description || parentId !== (node.parentId ?? ''));
	function resetAbout() {
		name = node.name;
		description = node.description;
		parentId = node.parentId ?? '';
	}
	$effect.pre(() => {
		const n = node;
		untrack(() => {
			if (n.id !== syncedFor) {
				syncedFor = n.id;
				resetAbout();
				selected = [];
				confirmDelete = false;
				showCreate = null;
				tab = 'main';
			}
		});
	});
	beforeNavigate(({ cancel, type, willUnload }) => {
		if (!dirty || type === 'form') return;
		if (willUnload) cancel();
		else if (!confirm('Du har endringer som ikke er lagret. Vil du forlate siden?')) cancel();
	});

	// --- Bilder ---
	let selected = $state<string[]>([]);
	let anchor = -1;
	$effect(() => {
		const ids = new Set(data.photos.map((p) => p.id));
		const current = untrack(() => selected);
		const next = current.filter((id) => ids.has(id));
		if (next.length !== current.length) selected = next;
	});
	const pending = $derived(data.photos.filter((p) => !p.stored).length);
	const allSelected = $derived(data.photos.length > 0 && selected.length === data.photos.length);

	/** Klikk velger/fjerner ett bilde; shift-klikk velger alt mellom forrige og dette. */
	function toggle(i: number, e: MouseEvent) {
		const id = data.photos[i].id;
		if (e.shiftKey && anchor >= 0 && anchor < data.photos.length) {
			const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
			const add = !selected.includes(id);
			const range = data.photos.slice(a, b + 1).map((p) => p.id);
			const set = new Set(selected);
			for (const r of range) add ? set.add(r) : set.delete(r);
			selected = data.photos.map((p) => p.id).filter((x) => set.has(x));
		} else {
			selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
		}
		anchor = i;
	}

	// Filnavn uten endelse, skilt med mellomrom: lim inn i Lightroom-filteret «Tekst → Filnavn → Inneholder».
	let copiedFor = $state<string | null>(null);
	async function copyNames(userId: string, photos: { filename: string }[]) {
		const text = photos.map((p) => p.filename.replace(/\.[^.]+$/, '')).join(' ');
		try {
			await navigator.clipboard.writeText(text);
			copiedFor = userId;
			toast('Filnavnene er kopiert. Lim dem inn i Lightroom-filteret.');
			setTimeout(() => (copiedFor = null), 2000);
		} catch {
			prompt('Kopier filnavnene:', text);
		}
	}

	async function copyAddress() {
		try {
			await navigator.clipboard.writeText(`${data.origin}${node.path}`);
			toast(mode === 'public' ? 'Lenken er kopiert.' : 'Lenken er kopiert. Den virker bare for deg og dem som har tilgang.');
		} catch {
			prompt('Kopier lenken:', `${data.origin}${node.path}`);
		}
	}

	const MODE = { public: 'Offentlig', private: 'Privat', client: 'Kunde' } as const;
	const MODE_ICON = { public: 'globe', private: 'lock', client: 'user' } as const;
</script>

<svelte:head><title>{node.name} – Administrer</title></svelte:head>

<Breadcrumbs crumbs={data.crumbs} root={{ name: 'Bibliotek', path: '/admin' }} />

<header class="head">
	<div class="title">
		<div class="kicker">
			<span class="kind">{isAlbum ? 'Album' : 'Mappe'}</span>
			<a class="pill {mode}" href="#tilgang" onclick={() => (tab = 'settings')}>
				<Icon name={MODE_ICON[mode]} size={13} />
				<span class="pt">{MODE[mode]}{#if mode === 'client' && clientNames.length}: {clientNames.join(', ')}{/if}</span>
			</a>
			{#if node.fromLightroom}<span class="badge" title="Publiseres fra Lightroom">Lightroom</span>{/if}
		</div>
		<h1>{node.name}</h1>
		<p class="meta">
			{isAlbum ? plural(node.photoCount, 'bilde', 'bilder') : `${plural(node.albumCount, 'album', 'album')} · ${plural(node.photoCount, 'bilde', 'bilder')}`}
		</p>
	</div>
	<div class="head-actions">
		<button class="btn" type="button" onclick={copyAddress}><Icon name="link" /> Kopier lenke</button>
		<a class="btn" href={node.path}><Icon name="external" /> Vis på nettstedet</a>
	</div>
</header>

<div class="tabs" role="tablist" aria-label="Visning">
	<button role="tab" aria-selected={tab === 'main'} class:on={tab === 'main'} onclick={() => (tab = 'main')}>
		{isAlbum ? `Bilder (${data.photos.length})` : `Innhold (${data.children.length})`}
	</button>
	<button role="tab" aria-selected={tab === 'settings'} class:on={tab === 'settings'} onclick={() => (tab = 'settings')}>Innstillinger</button>
</div>

<div class="layout">
	<section class="main" class:off={tab !== 'main'}>
		{#if isAlbum}
			<Uploader albumId={node.id} />

			<div class="toolbar" class:active={selected.length > 0}>
				<div class="left">
					<label class="check">
						<input
							type="checkbox"
							checked={allSelected}
							indeterminate={selected.length > 0 && !allSelected}
							onchange={() => (selected = allSelected ? [] : data.photos.map((p) => p.id))}
							disabled={!data.photos.length}
						/>
						{selected.length ? `${selected.length} valgt` : plural(data.photos.length, 'bilde', 'bilder')}
					</label>
					{#if pending}
						<span class="badge" title="Originalene sendes til lagringen i bakgrunnen">
							<Icon name="clock" size={12} />
							{pending} venter på lagring
						</span>
					{/if}
				</div>
				<div class="right">
					{#if selected.length}
						{#if selected.length === 1 && selected[0] !== data.cover?.photoId}
							<form method="POST" action="?/setCover" use:enhance={submit()} class="inline">
								<input type="hidden" name="photo" value={selected[0]} />
								<button class="btn" type="submit"><Icon name="star" /> Bruk som forside</button>
							</form>
						{/if}
						<form method="POST" action="?/movePhotos" use:enhance={submit({ onsuccess: () => (selected = []) })} class="inline">
							{#each selected as id (id)}<input type="hidden" name="photo" value={id} />{/each}
							<select class="input small" name="target" bind:value={target} required aria-label="Flytt til album">
								<option value="" disabled>Flytt til album …</option>
								{#each data.albums as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
							</select>
							<button class="btn" type="submit" disabled={!target}><Icon name="move" /> Flytt</button>
						</form>
						{#if confirmPhotos}
							<form
								method="POST"
								action="?/deletePhotos"
								class="inline"
								use:enhance={submit({
									onsuccess: () => {
										confirmPhotos = false;
										selected = [];
									}
								})}
							>
								{#each selected as id (id)}<input type="hidden" name="photo" value={id} />{/each}
								<button class="btn danger solid" type="submit">Slett {selected.length} for godt</button>
								<button class="btn ghost" type="button" onclick={() => (confirmPhotos = false)}>Avbryt</button>
							</form>
						{:else}
							<button class="btn danger" onclick={() => (confirmPhotos = true)}><Icon name="trash" /> Slett</button>
						{/if}
						<button class="btn ghost" type="button" onclick={() => (selected = [])}>Fjern valg</button>
					{:else if data.photos.length > 1}
						<form method="POST" action="?/sortByDate" use:enhance={submit()} class="inline">
							<button class="btn ghost" type="submit"><Icon name="sort" /> Sorter etter dato tatt</button>
						</form>
					{/if}
				</div>
			</div>

			{#if data.photos.length}
				<ul class="photos">
					{#each data.photos as p, i (p.id)}
						{@const isCover = data.cover?.photoId === p.id}
						<li class:selected={selected.includes(p.id)}>
							<button
								class="thumb"
								onclick={(e) => toggle(i, e)}
								style:background-color={p.color}
								aria-pressed={selected.includes(p.id)}
								aria-label="Velg {p.filename}"
							>
								<img src={p.src} srcset={p.srcset} sizes="200px" alt="" loading="lazy" />
								<span class="tick"><Icon name="check" size={14} /></span>
								{#if isCover}<span class="cover-tag"><Icon name="star" size={12} filled /> Forside</span>{/if}
								{#if !p.stored}
									<span class="state" class:bad={!!p.error} title={p.error ?? 'Venter på å bli sendt til lagringen'}>
										<Icon name={p.error ? 'cloud' : 'clock'} size={12} />
									</span>
								{/if}
							</button>
							<div class="cap">
								<span class="fname" title={p.filename}>{p.title || p.filename}</span>
								<span class="faint">{p.takenAt ? formatDate(p.takenAt) : formatBytes(p.bytes)}</span>
							</div>
							{#if !isCover}
								<form method="POST" action="?/setCover" use:enhance={submit()} class="set-cover">
									<input type="hidden" name="photo" value={p.id} />
									<button class="mini" type="submit" title="Bruk som forsidebilde" aria-label="Bruk {p.filename} som forsidebilde">
										<Icon name="star" size={14} />
									</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
				{#if data.photos.length > 1}<p class="tip faint">Tips: shift-klikk for å velge mange bilder på rad.</p>{/if}
			{:else}
				<p class="muted empty">Ingen bilder ennå. Last opp her, eller publiser fra Lightroom.</p>
			{/if}
		{:else}
			<div class="children-head">
				<h2>Innhold</h2>
				<div class="buttons">
					<button class="btn" onclick={() => (showCreate = 'folder')}><Icon name="folder" /> Ny mappe her</button>
					<button class="btn primary" onclick={() => (showCreate = 'album')}><Icon name="plus" /> Nytt album her</button>
				</div>
			</div>
			{#if showCreate}
				<form method="POST" action="?/create" class="create" use:enhance={submit()}>
					<input type="hidden" name="type" value={showCreate} />
					<label class="field">
						<span>Navn på {showCreate === 'album' ? 'nytt album' : 'ny mappe'}</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input class="input" name="name" required maxlength="200" autofocus />
					</label>
					<label class="field">
						<span>Synlighet</span>
						<select class="input" name="visibility">
							<option value="public">Offentlig</option>
							<option value="private">Privat</option>
						</select>
					</label>
					<div class="buttons">
						<button class="btn primary" type="submit">Opprett</button>
						<button class="btn ghost" type="button" onclick={() => (showCreate = null)}>Avbryt</button>
					</div>
				</form>
			{/if}
			{#if data.children.length}
				<ul class="children">
					{#each data.children as c (c.id)}
						<li>
							<a href="/admin/node/{c.id}">
								<span class="cthumb" style:background-color={c.cover?.color}>
									{#if c.cover}<img src={c.cover.src} srcset={c.cover.srcset} sizes="56px" alt="" loading="lazy" />{:else}<Icon
											name={c.type === 'folder' ? 'folder' : 'image'}
											size={18}
										/>{/if}
								</span>
								<span class="ctext">
									<span class="label">{c.name}</span>
									<span class="faint">
										{c.type === 'folder' ? 'Mappe · ' : ''}{c.type === 'album' ? plural(c.photoCount, 'bilde', 'bilder') : plural(c.albumCount, 'album', 'album')}
									</span>
								</span>
								<span class="pill {c.mode}">
									<Icon name={MODE_ICON[c.mode]} size={12} />
									<span class="pt">{c.mode === 'client' && c.clients.length ? c.clients.join(', ') : MODE[c.mode]}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted empty">Mappa er tom.</p>
			{/if}
		{/if}
	</section>

	<aside class="side" class:off={tab !== 'settings'}>
		<section class="panel">
			<div class="panel-head">
				<h2>Forsidebilde</h2>
				{#if data.cover && !data.cover.auto}
					<form method="POST" action="?/setCover" use:enhance={submit()}>
						<input type="hidden" name="photo" value="" />
						<button class="linkish" type="submit">Velg automatisk</button>
					</form>
				{/if}
			</div>
			<button class="cover" type="button" onclick={() => (picker = true)} style:background-color={data.cover?.color}>
				{#if data.cover}
					<img src={data.cover.src} srcset={data.cover.srcset} sizes="360px" alt="Forsidebildet" />
				{:else}
					<span class="no-cover"><Icon name="image" size={26} /> Ingen bilder ennå</span>
				{/if}
				<span class="cover-cta"><Icon name="edit" size={14} /> {data.cover ? 'Bytt forsidebilde' : 'Velg forsidebilde'}</span>
			</button>
			<p class="hint">
				{#if !data.cover}
					Last opp bilder først.
				{:else if data.cover.auto}
					Velges automatisk ({isAlbum ? 'første bilde i albumet' : 'fra albumene i mappa'}).
				{:else}
					Valgt av deg.
				{/if}
				Vises på kortet på forsiden og når lenken deles.
			</p>
		</section>

		<AccessPanel node={{ id: node.id, type: node.type, allowDownload: node.allowDownload }} access={data.access} mailReady={data.mailReady} />

		<form method="POST" action="?/save" use:enhance={submit()} class="panel">
			<h2>Om {it}</h2>
			{#if node.fromLightroom}
				<p class="hint">
					Kommer fra Lightroom: navn og mappe styres derfra og overskrives neste gang du publiserer. Beskrivelsen beholdes.
				</p>
			{/if}
			<label class="field">
				<span>Navn</span>
				<input class="input" name="name" bind:value={name} required maxlength="200" />
			</label>
			<label class="field">
				<span>Beskrivelse</span>
				<textarea class="input" name="description" bind:value={description} rows="4" placeholder="Vises øverst på {isAlbum ? 'albumsiden' : 'mappesiden'}"
				></textarea>
			</label>
			<label class="field">
				<span>Ligger i mappa</span>
				<select class="input" name="parentId" bind:value={parentId}>
					<option value="">Toppnivå (forsiden)</option>
					{#each data.folders as f (f.id)}
						<option value={f.id}>{' '.repeat(f.depth * 3)}{f.label}</option>
					{/each}
				</select>
			</label>
			<div class="addr">
				<span class="faint">Adresse</span>
				<a href={node.path}>{data.origin.replace(/^https?:\/\//, '')}{node.path}</a>
			</div>
			<div class="save-row">
				<button class="btn primary" type="submit" disabled={!dirty}>Lagre</button>
				{#if dirty}
					<button class="btn ghost" type="button" onclick={resetAbout}>Angre</button>
					<span class="unsaved">Ikke lagret</span>
				{/if}
			</div>
		</form>

		{#if isAlbum && data.favorites.length}
			<div class="panel" id="favoritter">
				<h2>Favoritter</h2>
				<p class="hint">Bildene gjestene har valgt med hjertet.</p>
				<ul class="favs">
					{#each data.favorites as f (f.user.id)}
						<li>
							<div>
								<strong>{f.user.name || f.user.email}</strong>
								<span class="faint">
									{plural(f.photos.length, 'bilde', 'bilder')} · {f.submittedAt ? `sendt ${formatLocal(f.submittedAt)}` : 'ikke sendt ennå'}
								</span>
							</div>
							<div class="buttons">
								<button class="btn" type="button" onclick={() => copyNames(f.user.id, f.photos)}>
									<Icon name={copiedFor === f.user.id ? 'check' : 'copy'} size={16} />
									{copiedFor === f.user.id ? 'Kopiert' : 'Kopier filnavn'}
								</button>
								<button
									class="btn ghost"
									type="button"
									onclick={() => {
										selected = f.photos.map((p) => p.id);
										tab = 'main';
									}}>Marker i albumet</button
								>
							</div>
						</li>
					{/each}
				</ul>
				<p class="hint">Lim filnavnene inn i Lightroom: Bibliotekfilter → Tekst → Filnavn → Inneholder.</p>
			</div>
		{/if}

		<div class="panel danger-zone">
			<h2>Slett</h2>
			<p class="hint">
				Sletter {isAlbum ? 'albumet' : 'mappa med alt innhold'} og originalene i lagringen. Filene på din egen disk (RAW) røres ikke.
			</p>
			{#if confirmDelete}
				<form method="POST" action="?/delete" use:enhance={submit()} class="buttons">
					<button class="btn danger solid" type="submit">Ja, slett for godt</button>
					<button class="btn ghost" type="button" onclick={() => (confirmDelete = false)}>Avbryt</button>
				</form>
			{:else}
				<button class="btn danger" onclick={() => (confirmDelete = true)}><Icon name="trash" /> Slett {isAlbum ? 'album' : 'mappe'}</button>
			{/if}
		</div>
	</aside>
</div>

<CoverPicker bind:open={picker} nodeId={node.id} current={data.cover?.photoId ?? null} isFolder={!isAlbum} />

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 14px;
		margin: 12px 0 22px;
	}
	.title {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.kicker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.kind {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
	}
	h1 {
		font-size: 28px;
		overflow-wrap: anywhere;
	}
	.meta {
		color: var(--muted);
		font-size: 14px;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 9px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill :global(svg) {
		flex: none;
	}
	.pt {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill.public {
		background: rgba(99, 210, 151, 0.12);
		color: var(--ok);
	}
	.pill.private {
		background: rgba(242, 193, 78, 0.14);
		color: var(--warn);
	}
	.pill.client {
		background: rgba(124, 183, 255, 0.14);
		color: #8fc1ff;
	}
	.tabs {
		display: none;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		gap: 28px;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.tabs {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 4px;
			padding: 4px;
			margin-bottom: 18px;
			border: 1px solid var(--line);
			border-radius: 12px;
			background: var(--surface);
		}
		.tabs button {
			min-height: 38px;
			border: 0;
			border-radius: 9px;
			background: none;
			color: var(--muted);
			font: inherit;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
		}
		.tabs button.on {
			background: var(--surface-3);
			color: var(--text);
		}
		.off {
			display: none !important;
		}
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 20px 0 12px;
		min-height: 40px;
	}
	.toolbar.active {
		position: sticky;
		top: 0;
		z-index: 6;
		margin-left: -10px;
		margin-right: -10px;
		padding: 8px 10px;
		border-radius: 0 0 12px 12px;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--line);
	}
	.left,
	.right,
	.inline,
	.buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.input.small {
		min-height: 38px;
		width: auto;
		max-width: 260px;
		padding: 6px 10px;
		font-size: 14px;
	}
	.photos {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 14px;
	}
	.photos li {
		position: relative;
	}
	.thumb {
		position: relative;
		display: block;
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border: 2px solid transparent;
		border-radius: 8px;
		overflow: hidden;
		cursor: pointer;
		background: var(--surface-2);
		user-select: none;
		-webkit-user-select: none;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.selected .thumb {
		border-color: var(--accent);
	}
	.selected .thumb img {
		transform: scale(0.94);
		border-radius: 4px;
	}
	.thumb img {
		transition: transform 0.15s;
	}
	.tick {
		position: absolute;
		left: 6px;
		top: 6px;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: rgba(12, 12, 13, 0.6);
		border: 1.5px solid rgba(255, 255, 255, 0.7);
		color: transparent;
	}
	.selected .tick {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.cover-tag {
		position: absolute;
		left: 6px;
		bottom: 6px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 11px;
		background: rgba(12, 12, 13, 0.75);
		color: var(--warn);
	}
	.state {
		position: absolute;
		right: 6px;
		top: 6px;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		background: rgba(12, 12, 13, 0.7);
		color: var(--warn);
	}
	.state.bad {
		color: var(--danger);
	}
	.cap {
		display: grid;
		padding: 6px 2px 0;
		font-size: 12px;
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.set-cover {
		position: absolute;
		right: 6px;
		bottom: 44px;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.photos li:hover .set-cover,
	.set-cover:focus-within {
		opacity: 1;
	}
	@media (hover: none) {
		.set-cover {
			display: none;
		}
	}
	.mini {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 999px;
		border: 0;
		background: rgba(12, 12, 13, 0.75);
		color: var(--text);
		cursor: pointer;
	}
	.mini:hover {
		color: var(--warn);
	}
	.tip {
		margin-top: 12px;
		font-size: 13px;
	}
	.empty {
		padding: 24px 0;
	}
	.children-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 14px;
	}
	.children-head h2,
	.panel h2 {
		font-size: 17px;
	}
	.create {
		display: grid;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
		margin-bottom: 14px;
	}
	.children {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
	}
	.children li + li {
		border-top: 1px solid var(--line);
	}
	.children a {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		background: var(--surface);
	}
	.children a:hover {
		background: var(--surface-2);
	}
	.cthumb {
		flex: none;
		width: 48px;
		height: 48px;
		border-radius: 8px;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: var(--surface-2);
		color: var(--faint);
	}
	.cthumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.ctext {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.ctext .label {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ctext .faint {
		font-size: 13px;
	}
	.side {
		display: grid;
		gap: 16px;
	}
	.panel {
		display: grid;
		gap: 14px;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.panel-head form {
		margin: 0;
	}
	.linkish {
		border: 0;
		background: none;
		padding: 0;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.linkish:hover {
		color: var(--text);
	}
	.cover {
		position: relative;
		display: block;
		width: 100%;
		aspect-ratio: 3 / 2;
		padding: 0;
		border: 0;
		border-radius: 10px;
		overflow: hidden;
		background: var(--surface-2);
		cursor: pointer;
	}
	.cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: transform 0.4s cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.cover:hover img {
		transform: scale(1.03);
	}
	.no-cover {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 8px;
		color: var(--faint);
		font-size: 14px;
	}
	.cover-cta {
		position: absolute;
		right: 10px;
		bottom: 10px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 11px;
		border-radius: 999px;
		background: rgba(12, 12, 13, 0.72);
		backdrop-filter: blur(6px);
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.addr {
		display: grid;
		gap: 2px;
		font-size: 13px;
	}
	.addr a {
		overflow-wrap: anywhere;
		color: var(--muted);
	}
	.addr a:hover {
		color: var(--text);
		text-decoration: underline;
	}
	.save-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.unsaved {
		font-size: 13px;
		color: var(--warn);
	}
	.favs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}
	.favs li {
		display: grid;
		gap: 8px;
	}
	.favs li > div:first-child {
		display: grid;
		gap: 2px;
	}
	.favs .faint {
		font-size: 13px;
	}
	.danger-zone {
		border-color: rgba(255, 107, 94, 0.25);
	}
</style>
