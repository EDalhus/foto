<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Uploader from '$lib/components/Uploader.svelte';
	import { formatBytes, formatDate, plural } from '$lib/format';

	let { data, form } = $props();
	const node = $derived(data.node);

	let selected = $state<string[]>([]);
	let confirmDelete = $state(false);
	let confirmPhotos = $state(false);
	let showCreate = $state<'album' | 'folder' | null>(null);
	let target = $state('');

	// Fjern valgte bilder som ikke finnes lenger (slettet/flyttet).
	$effect(() => {
		const ids = new Set(data.photos.map((p) => p.id));
		const current = untrack(() => selected);
		const next = current.filter((id) => ids.has(id));
		if (next.length !== current.length) selected = next;
	});
	$effect(() => {
		void node.id;
		confirmDelete = false;
		showCreate = null;
	});

	const pending = $derived(data.photos.filter((p) => !p.stored).length);
	const allSelected = $derived(data.photos.length > 0 && selected.length === data.photos.length);

	function toggle(id: string) {
		selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
	}
</script>

<svelte:head><title>{node.name} – Administrer</title></svelte:head>

<Breadcrumbs crumbs={data.crumbs} root={{ name: 'Bibliotek', path: '/admin' }} />

<div class="head">
	<div class="title">
		<span class="kind">{node.type === 'album' ? 'Album' : 'Mappe'}</span>
		<h1>{node.name}</h1>
	</div>
	<a class="btn" href={node.path}><Icon name="external" /> Vis på nettstedet</a>
</div>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
{#if form?.message}<p class="notice success" role="status">{form.message}</p>{/if}
{#if form?.saved}<p class="notice success" role="status">Lagret.</p>{/if}

<div class="layout">
	<section class="main">
		{#if node.type === 'album'}
			<Uploader albumId={node.id} />

			<div class="toolbar">
				<div class="left">
					<label class="check">
						<input
							type="checkbox"
							checked={allSelected}
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
						<form method="POST" action="?/movePhotos" use:enhance class="inline">
							{#each selected as id (id)}<input type="hidden" name="photo" value={id} />{/each}
							<select class="input small" name="target" bind:value={target} required>
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
								use:enhance={() =>
									async ({ update }) => {
										confirmPhotos = false;
										selected = [];
										await update();
									}}
							>
								{#each selected as id (id)}<input type="hidden" name="photo" value={id} />{/each}
								<button class="btn danger solid" type="submit">Slett {selected.length} for godt</button>
								<button class="btn ghost" type="button" onclick={() => (confirmPhotos = false)}>Avbryt</button>
							</form>
						{:else}
							<button class="btn danger" onclick={() => (confirmPhotos = true)}><Icon name="trash" /> Slett</button>
						{/if}
					{:else if data.photos.length > 1}
						<form method="POST" action="?/sortByDate" use:enhance class="inline">
							<button class="btn ghost" type="submit"><Icon name="sort" /> Sorter etter dato tatt</button>
						</form>
					{/if}
				</div>
			</div>

			{#if data.photos.length}
				<ul class="photos">
					{#each data.photos as p (p.id)}
						<li class:selected={selected.includes(p.id)}>
							<button class="thumb" onclick={() => toggle(p.id)} style:background-color={p.color} aria-pressed={selected.includes(p.id)} aria-label="Velg {p.filename}">
								<img src={p.src} srcset={p.srcset} sizes="200px" alt="" loading="lazy" />
								<span class="tick"><Icon name="check" size={14} /></span>
								{#if node.coverPhotoId === p.id}<span class="cover-tag"><Icon name="star" size={12} /> Forside</span>{/if}
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
							{#if node.coverPhotoId !== p.id}
								<form method="POST" action="?/setCover" use:enhance class="set-cover">
									<input type="hidden" name="photo" value={p.id} />
									<button class="mini" type="submit" title="Bruk som forsidebilde"><Icon name="star" size={14} /></button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
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
				<form method="POST" action="?/create" class="create" use:enhance>
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
								<Icon name={c.type === 'folder' ? 'folder' : 'image'} size={17} />
								<span class="label">{c.name}</span>
								<span class="faint">
									{c.type === 'album' ? plural(c.photoCount, 'bilde', 'bilder') : plural(c.albumCount, 'album', 'album')}
								</span>
								{#if c.isPrivate}<span class="badge private"><Icon name="lock" size={12} /> Privat</span>{/if}
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted empty">Mappa er tom.</p>
			{/if}
		{/if}
	</section>

	<aside class="side">
		<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })} class="panel">
			<h2>Innstillinger</h2>
			{#if node.fromLightroom}
				<p class="hint">
					Dette {node.type === 'album' ? 'albumet' : 'mappa'} kommer fra Lightroom. Navn og plassering styres derfra – endrer du dem her,
					overskrives de neste gang du publiserer. Synlighet{node.type === 'album' ? ' og nedlasting' : ''} kan endres begge steder; det du
					lagret sist, gjelder.
				</p>
			{/if}
			<label class="field">
				<span>Navn</span>
				<input class="input" name="name" value={node.name} required maxlength="200" />
			</label>
			<label class="field">
				<span>Beskrivelse</span>
				<textarea class="input" name="description" rows="3">{node.description}</textarea>
			</label>
			<label class="field">
				<span>Ligger i</span>
				<select class="input" name="parentId" value={node.parentId ?? ''}>
					<option value="">Toppnivå</option>
					{#each data.folders as f (f.id)}
						<option value={f.id}>{'   '.repeat(f.depth)}{f.label}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				<span>Synlighet</span>
				<select class="input" name="visibility" value={node.visibility}>
					<option value="public">Offentlig – alle kan se</option>
					<option value="private">Privat – bare deg og gjester du deler med</option>
				</select>
			</label>
			{#if node.effectivePrivate && node.visibility === 'public'}
				<p class="hint"><Icon name="lock" size={12} /> Ligger i en privat mappe, så den er privat uansett.</p>
			{/if}
			{#if node.type === 'album'}
				<label class="check">
					<input type="checkbox" name="allowDownload" checked={node.allowDownload} />
					Tillat nedlasting av originaler
				</label>
				<p class="hint">Gjelder besøkende. Du kan alltid laste ned selv når du er innlogget.</p>
			{/if}
			<button class="btn primary" type="submit">Lagre</button>
		</form>

		<form method="POST" action="?/share" use:enhance={() => async ({ update }) => update({ reset: false })} class="panel">
			<h2>Deling</h2>
			{#if data.sharing.length}
				<p class="hint">
					{node.effectivePrivate
						? `Velg hvem som skal se ${node.type === 'album' ? 'albumet' : 'mappa med alt innhold'}.`
						: `${node.type === 'album' ? 'Albumet' : 'Mappa'} er offentlig, så alle ser det. Deler du det, havner det også under «Delt med deg» hos gruppa.`}
				</p>
				<div class="groups">
					{#each data.sharing as g (g.id)}
						<label class="check">
							<input type="checkbox" name="group" value={g.id} checked={g.direct || !!g.via} disabled={!!g.via && !g.direct} />
							<span>{g.name}{#if g.via && !g.direct}{' '}<span class="faint">– via «{g.via}»</span>{/if}</span>
						</label>
					{/each}
				</div>
				<button class="btn" type="submit">Lagre deling</button>
			{:else}
				<p class="hint">Lag en gruppe under <a href="/admin/gjester">Gjester</a> for å dele med familie, venner eller kunder.</p>
			{/if}
		</form>

		<div class="panel danger-zone">
			<h2>Slett</h2>
			<p class="hint">
				Sletter {node.type === 'album' ? 'albumet' : 'mappa med alt innhold'} og originalene i lagringen. Filene på din egen
				disk (RAW) røres ikke.
			</p>
			{#if confirmDelete}
				<form method="POST" action="?/delete" use:enhance class="buttons">
					<button class="btn danger solid" type="submit">Ja, slett for godt</button>
					<button class="btn ghost" type="button" onclick={() => (confirmDelete = false)}>Avbryt</button>
				</form>
			{:else}
				<button class="btn danger" onclick={() => (confirmDelete = true)}><Icon name="trash" /> Slett {node.type === 'album' ? 'album' : 'mappe'}</button>
			{/if}
		</div>
	</aside>
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
		margin: 10px 0 20px;
	}
	.kind {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
	}
	h1 {
		font-size: 28px;
		margin-top: 2px;
	}
	.notice {
		margin-bottom: 16px;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 28px;
		align-items: start;
	}
	@media (max-width: 960px) {
		.layout {
			grid-template-columns: 1fr;
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
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.selected .thumb {
		border-color: var(--accent);
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
		background: rgba(12, 12, 13, 0.7);
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
		gap: 10px;
		padding: 12px 14px;
		background: var(--surface);
	}
	.children a:hover {
		background: var(--surface-2);
	}
	.children .label {
		flex: 1;
		font-weight: 500;
	}
	.groups {
		display: grid;
		gap: 8px;
	}
	.hint a {
		text-decoration: underline;
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
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.danger-zone {
		border-color: rgba(255, 107, 94, 0.25);
	}
</style>
