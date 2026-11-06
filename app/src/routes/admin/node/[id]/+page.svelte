<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import AccessPanel from '$lib/components/AccessPanel.svelte';
	import BarChart from '$lib/components/BarChart.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CategoryPanel from '$lib/components/CategoryPanel.svelte';
	import CoverPicker from '$lib/components/CoverPicker.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Uploader from '$lib/components/Uploader.svelte';
	import { formatBytes, formatDate, formatDuration, formatLocal, mediaCount, plural } from '$lib/format';
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
	let categoryId = $state(untrack(() => data.node.categoryId ?? ''));
	let syncedFor = untrack(() => data.node.id);
	const dirty = $derived(
		name !== node.name || description !== node.description || parentId !== (node.parentId ?? '') || categoryId !== (node.categoryId ?? '')
	);
	// Kategorien hører til mappa: velges en annen mappe, gjelder ikke kategorivalget lenger.
	const moving = $derived(parentId !== (node.parentId ?? ''));
	function resetAbout() {
		name = node.name;
		description = node.description;
		parentId = node.parentId ?? '';
		categoryId = node.categoryId ?? '';
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
	const videosPending = $derived(data.photos.filter((p) => p.videoState === 'pending').length);
	const videosFailed = $derived(data.photos.filter((p) => p.videoState === 'failed'));
	const videoCount = $derived(data.photos.filter((p) => p.kind === 'video').length);
	const countText = $derived(mediaCount(data.photos.length - videoCount, videoCount));
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

	// Statistikk (siste 30 dager) og hva hver gjest har gjort.
	const dayShort = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
	const statBars = $derived(
		data.stats.series.map((p) => ({ short: '', label: dayShort.format(new Date(`${p.key}T12:00:00Z`)), value: p.views }))
	);
	const activity = $derived(Object.fromEntries(data.stats.guests.map((g) => [g.userId, g])));

	const MODE = { public: 'Offentlig', private: 'Privat', client: 'Kunde' } as const;
	const MODE_ICON = { public: 'globe', private: 'lock', client: 'user' } as const;

	// Innholdet i mappa, gruppert etter kategori (i kategorienes rekkefølge, «Uten kategori» sist).
	const childGroups = $derived.by(() => {
		const cats = data.categories;
		if (!cats.length) return [{ key: 'alle', name: '', hex: null as string | null, items: data.children }];
		const known = new Set(cats.map((c) => c.id));
		const groups = cats.map((c) => ({ key: c.id, name: c.name, hex: c.hex, items: data.children.filter((x) => x.categoryId === c.id) }));
		const rest = data.children.filter((x) => !x.categoryId || !known.has(x.categoryId));
		return [...groups, { key: 'ingen', name: 'Uten kategori', hex: null, items: rest }].filter((g) => g.items.length);
	});
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
			{isAlbum ? countText : `${plural(node.albumCount, 'album', 'album')} · ${plural(node.photoCount, 'bilde', 'bilder')}`}
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
						{selected.length ? `${selected.length} valgt` : countText}
					</label>
					{#if videosPending}
						<span class="badge" title="Videoer gjøres klare for avspilling i bakgrunnen, én om gangen">
							<span class="spin" aria-hidden="true"></span>
							{videosPending === 1 ? '1 video gjøres klar' : `${videosPending} videoer gjøres klare`}
						</span>
					{/if}
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

			{#if videosFailed.length}
				<div class="notice-bad" role="status">
					<Icon name="info" size={16} />
					<span>
						{videosFailed.length === 1 ? 'En video' : `${videosFailed.length} videoer`} kunne ikke gjøres klar for avspilling
						({videosFailed[0].videoError ?? 'ukjent feil'}). Originalen er lagret og kan lastes ned.
					</span>
					<form method="POST" action="?/retryVideo" use:enhance={submit()}>
						<input type="hidden" name="photo" value={videosFailed[0].id} />
						<button class="btn" type="submit">Prøv igjen</button>
					</form>
				</div>
			{/if}
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
								{#if p.kind === 'video'}
									<span class="vtag" class:bad={p.videoState === 'failed'} title={p.videoState === 'failed' ? (p.videoError ?? 'Feilet') : p.videoState === 'pending' ? 'Gjøres klar for avspilling' : 'Video'}>
										{#if p.videoState === 'pending'}<span class="spin" aria-hidden="true"></span>{:else}<Icon name="play" size={11} filled />{/if}
										{formatDuration(p.duration)}
									</span>
								{/if}
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
				{#each childGroups as g (g.key)}
					{#if data.categories.length}
						<h3 class="cgroup">
							<span class="cdot" class:none={!g.hex} style:background={g.hex ?? undefined}></span>{g.name}
							<span class="faint">{g.items.length}</span>
						</h3>
					{/if}
					<ul class="children">
						{#each g.items as c (c.id)}
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
								{#if data.categories.length}
									<form method="POST" action="?/setCategory" use:enhance={submit()} class="ccat">
										<input type="hidden" name="node" value={c.id} />
										<select
											class="input small"
											name="category"
											aria-label="Kategori for {c.name}"
											value={c.categoryId ?? ''}
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										>
											<option value="">Uten kategori</option>
											{#each data.categories as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
										</select>
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				{/each}
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

		{#if !isAlbum}
			<CategoryPanel categories={data.categories} style={data.categoryStyle} colors={data.colors} previewHref={node.path} />
		{/if}

		<AccessPanel node={{ id: node.id, type: node.type, allowDownload: node.allowDownload }} access={data.access} mailReady={data.mailReady} {activity} />

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
			{#if data.parentCategories.length && !moving}
				<label class="field">
					<span>Kategori i mappa</span>
					<select class="input" name="categoryId" bind:value={categoryId}>
						<option value="">Uten kategori</option>
						{#each data.parentCategories as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
					</select>
				</label>
			{/if}
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

		{#if isAlbum && (data.favorites.length || data.access.groups.some((g) => g.shared))}
			<div class="panel" id="favoritter">
				<h2>Kundens valg</h2>
				<form method="POST" action="?/pickCount" use:enhance={submit()} class="pick-row">
					<label for="pick-count">Gjestene skal velge</label>
					<input id="pick-count" class="input small num" type="number" name="count" min="1" max="10000" value={node.pickCount ?? ''} placeholder="fritt" />
					<span>bilder</span>
					<button class="btn" type="submit">Lagre</button>
				</form>
				<p class="hint">
					Står feltet tomt, kan de velge så mange de vil. Med et antall ser de «12 av {node.pickCount ?? 30} valgt» og kan ikke velge flere.
					Valget låses når det er sendt.
				</p>
				{#if data.favorites.length}
					<ul class="favs">
						{#each data.favorites as f (f.user.id)}
							<li>
								<div>
									<strong>{f.user.name || f.user.email}</strong>
									<span class="faint">
										{node.pickCount ? `${f.photos.length} av ${node.pickCount}` : plural(f.photos.length, 'bilde', 'bilder')} ·
										{#if f.lockedAt}sendt {formatLocal(f.lockedAt)} · låst{:else if f.submittedAt}sendt {formatLocal(f.submittedAt)} · låst opp{:else}ikke sendt
											ennå{/if}
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
									{#if f.lockedAt}
										<form method="POST" action="?/unlockFavorites" use:enhance={submit()}>
											<input type="hidden" name="user" value={f.user.id} />
											<button class="btn ghost" type="submit" title="La {f.user.name || f.user.email} endre valget"><Icon name="lock" size={16} /> Lås opp</button>
										</form>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					<p class="hint">Lim filnavnene inn i Lightroom: Bibliotekfilter → Tekst → Filnavn → Inneholder.</p>
				{:else}
					<p class="hint">Ingen har valgt bilder ennå. Gjestene velger med hjertet på bildene.</p>
				{/if}
			</div>
		{/if}

		<section class="panel stats">
			<div class="panel-head">
				<h2>Statistikk</h2>
				<a class="linkish" href="/admin/statistikk">Alt</a>
			</div>
			<div class="stat-row">
				<div><strong>{data.stats.last30.views.toLocaleString('nb-NO')}</strong><span>visninger</span></div>
				{#if isAlbum}<div><strong>{data.stats.last30.downloads.toLocaleString('nb-NO')}</strong><span>bilder lastet ned</span></div>{/if}
				{#if data.stats.last30.zips}<div><strong>{data.stats.last30.zips}</strong><span>som zip</span></div>{/if}
			</div>
			{#if data.stats.last30.views}
				<BarChart bars={statBars} unit={['visning', 'visninger']} height={56} compact />
			{/if}
			<p class="hint">
				Siste 30 dager. Totalt {plural(data.stats.total.views, 'visning', 'visninger')}{isAlbum
					? ` og ${plural(data.stats.total.downloads, 'nedlasting', 'nedlastinger')}`
					: ''}. Du selv telles ikke.
			</p>
			{#if data.stats.guests.length}
				<ul class="guest-stats">
					{#each data.stats.guests as g (g.userId)}
						<li>
							<strong>{g.name || g.email}</strong>
							<span class="faint">
								{plural(g.views, 'visning', 'visninger')}{g.downloads ? ` · ${plural(g.downloads, 'bilde', 'bilder')} lastet ned` : ''}{g.zips
									? ` · hele albumet ${g.zips === 1 ? 'én gang' : `${g.zips} ganger`}`
									: ''} · sist {formatLocal(g.lastAt)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

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
		background-clip: padding-box;
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
	/* Ved siden av avkrysningen (stjernen for forsidebilde og lagringsstatus har de andre hjørnene). */
	.vtag {
		position: absolute;
		left: 33px;
		top: 7px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		background: rgba(12, 12, 13, 0.75);
		color: #fff;
	}
	.vtag :global(svg) {
		stroke-width: 0;
	}
	.vtag.bad {
		color: var(--danger);
	}
	.spin {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 999px;
		border: 1.5px solid rgba(255, 255, 255, 0.3);
		border-top-color: currentColor;
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.notice-bad {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin: 0 0 14px;
		padding: 10px 12px;
		border: 1px solid rgba(255, 107, 94, 0.35);
		border-radius: 12px;
		background: rgba(255, 107, 94, 0.08);
		font-size: 14px;
	}
	.notice-bad span {
		flex: 1;
		min-width: 220px;
	}
	.notice-bad form {
		margin: 0;
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
	.children li {
		display: flex;
		align-items: center;
		background: var(--surface);
	}
	.children li:hover {
		background: var(--surface-2);
	}
	.children li + li {
		border-top: 1px solid var(--line);
	}
	.children a {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
	}
	.ccat {
		flex: none;
		margin: 0;
		padding-right: 10px;
	}
	.ccat select {
		max-width: 170px;
	}
	.cgroup {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 22px 0 10px;
		font-size: 14px;
		font-weight: 600;
		letter-spacing: 0;
	}
	.cgroup:first-of-type {
		margin-top: 4px;
	}
	.cgroup .faint {
		font-weight: 400;
	}
	.cdot {
		flex: none;
		width: 9px;
		height: 9px;
		border-radius: 999px;
	}
	.cdot.none {
		border: 1.5px solid var(--faint);
	}
	@media (max-width: 560px) {
		.children li {
			flex-wrap: wrap;
		}
		.ccat {
			width: 100%;
			padding: 0 14px 10px 74px;
		}
		.ccat select {
			max-width: none;
			width: 100%;
		}
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
	.pick-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}
	.input.num {
		width: 84px;
	}
	.favs form {
		margin: 0;
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
	.stat-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 22px;
	}
	.stat-row div {
		display: grid;
	}
	.stat-row strong {
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
	.stat-row span {
		font-size: 12px;
		color: var(--muted);
	}
	.guest-stats {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
		font-size: 13px;
	}
	.guest-stats li {
		display: grid;
	}
	.danger-zone {
		border-color: rgba(255, 107, 94, 0.25);
	}
</style>
