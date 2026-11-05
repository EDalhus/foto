<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { formatMonth, plural } from '$lib/format';
	import { submit } from '$lib/submit';
	import type { AccessMode } from '$lib/types';

	let { data } = $props();
	let showCreate = $state(false);
	let createType = $state<'album' | 'folder'>('album');

	// --- Filter og søk ---
	type Filter = 'all' | AccessMode;
	let filter = $state<Filter>('all');
	let query = $state('');
	const norm = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '');
	const counts = $derived({
		all: data.rows.length,
		public: data.rows.filter((r) => r.mode === 'public').length,
		private: data.rows.filter((r) => r.mode === 'private').length,
		client: data.rows.filter((r) => r.mode === 'client').length
	});
	const flat = $derived(filter !== 'all' || query.trim() !== '');
	const matches = $derived.by(() => {
		const q = norm(query.trim());
		return data.rows.filter(
			(r) => (filter === 'all' || r.mode === filter) && (!q || norm(`${r.name} ${r.trail} ${r.clients.join(' ')} ${r.groups.join(' ')}`).includes(q))
		);
	});

	// --- Sammenleggbare mapper (huskes i nettleseren) ---
	let collapsed = $state(new Set<string>());
	onMount(() => {
		try {
			collapsed = new Set(JSON.parse(localStorage.getItem('foto:bibliotek:lukket') ?? '[]'));
		} catch {
			// privat modus o.l.
		}
	});
	function toggleFolder(id: string) {
		const next = new Set(collapsed);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		collapsed = next;
		try {
			localStorage.setItem('foto:bibliotek:lukket', JSON.stringify([...next]));
		} catch {
			// ikke så farlig
		}
	}
	const visible = $derived(flat ? matches : data.rows.filter((r) => !r.ancestors.some((a) => collapsed.has(a))));

	// --- Valg og handlinger på flere ---
	let selected = $state<string[]>([]);
	let confirmPublic = $state(false);
	let shareTo = $state('');
	let moveTo = $state('__');
	$effect(() => {
		const ids = new Set(data.rows.map((r) => r.id));
		if (selected.some((id) => !ids.has(id))) selected = selected.filter((id) => ids.has(id));
	});
	const allVisibleSelected = $derived(visible.length > 0 && visible.every((r) => selected.includes(r.id)));
	function toggle(id: string) {
		selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
		confirmPublic = false;
	}
	function toggleAll() {
		const ids = visible.map((r) => r.id);
		selected = allVisibleSelected ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])];
	}
	const selectedRows = $derived(data.rows.filter((r) => selected.includes(r.id)));
	const lightroomSelected = $derived(selectedRows.filter((r) => r.fromLightroom).length);
	const done = (d: Record<string, unknown> | undefined) => {
		if (d?.done) {
			selected = [];
			confirmPublic = false;
			shareTo = '';
			moveTo = '__';
		}
	};

	const MODE = { public: 'Offentlig', private: 'Privat', client: 'Kunde' } as const;
	const MODE_ICON = { public: 'globe', private: 'lock', client: 'user' } as const;
	const FILTERS: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'Alle' },
		{ id: 'public', label: 'Offentlige' },
		{ id: 'private', label: 'Private' },
		{ id: 'client', label: 'Kunder' }
	];
</script>

<svelte:head><title>Bibliotek – {data.site.title}</title></svelte:head>

<div class="head">
	<div>
		<h1>Bibliotek</h1>
		<p class="muted">Mapper og album. Det du publiserer fra Lightroom havner her automatisk.</p>
	</div>
	<div class="buttons">
		<button class="btn" onclick={() => ((createType = 'folder'), (showCreate = true))}><Icon name="folder" /> Ny mappe</button>
		<button class="btn primary" onclick={() => ((createType = 'album'), (showCreate = true))}><Icon name="plus" /> Nytt album</button>
	</div>
</div>

{#if showCreate}
	<form method="POST" action="?/create" class="create" use:enhance={submit()}>
		<input type="hidden" name="type" value={createType} />
		<h2>{createType === 'album' ? 'Nytt album' : 'Ny mappe'}</h2>
		<div class="grid">
			<label class="field">
				<span>Navn</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input class="input" name="name" required maxlength="200" autofocus />
			</label>
			<label class="field">
				<span>Ligger i</span>
				<select class="input" name="parentId">
					<option value="">Toppnivå</option>
					{#each data.folders as f (f.id)}
						<option value={f.id}>{' '.repeat(f.depth * 3)}{f.label}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				<span>Synlighet</span>
				<select class="input" name="visibility">
					<option value="public">Offentlig</option>
					<option value="private">Privat – bare deg og dem du deler med</option>
				</select>
			</label>
		</div>
		{#if createType === 'album'}
			<label class="check"><input type="checkbox" name="allowDownload" /> Tillat nedlasting av originaler i full oppløsning</label>
		{/if}
		<p class="hint">Kunder og grupper velger du på {createType === 'album' ? 'albumet' : 'mappa'} etterpå.</p>
		<div class="buttons">
			<button class="btn primary" type="submit">Opprett</button>
			<button class="btn ghost" type="button" onclick={() => (showCreate = false)}>Avbryt</button>
		</div>
	</form>
{/if}

{#if data.rows.length}
	<div class="filters">
		<div class="search">
			<Icon name="search" size={16} />
			<input class="input" type="search" bind:value={query} placeholder="Finn album, mappe eller kunde …" aria-label="Filtrer" />
		</div>
		<div class="chips" role="group" aria-label="Vis">
			{#each FILTERS as f (f.id)}
				<button class="chip" class:on={filter === f.id} aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
					{#if f.id !== 'all'}<Icon name={MODE_ICON[f.id]} size={13} />{/if}
					{f.label} <span class="n">{counts[f.id]}</span>
				</button>
			{/each}
		</div>
	</div>

	{#if selected.length}
		<div class="bulk" role="region" aria-label="Handlinger for valgte">
			<strong>{selected.length} valgt</strong>
			{#if confirmPublic}
				<form method="POST" action="?/bulk" use:enhance={submit({ onsuccess: done })} class="inline confirm">
					{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
					<input type="hidden" name="op" value="public" />
					<span>Alle kan da se bildene.</span>
					<button class="btn primary" type="submit"><Icon name="globe" /> Gjør offentlig</button>
					<button class="btn ghost" type="button" onclick={() => (confirmPublic = false)}>Avbryt</button>
				</form>
			{:else}
				<button class="btn" type="button" onclick={() => (confirmPublic = true)}><Icon name="globe" /> Gjør offentlig</button>
				<form method="POST" action="?/bulk" use:enhance={submit({ onsuccess: done })} class="inline">
					{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
					<input type="hidden" name="op" value="private" />
					<button class="btn" type="submit"><Icon name="lock" /> Gjør privat</button>
				</form>
				{#if data.groups.length}
					<form method="POST" action="?/bulk" use:enhance={submit({ onsuccess: done })} class="inline">
						{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
						<input type="hidden" name="op" value="share" />
						<select class="input small" name="group" bind:value={shareTo} aria-label="Del med gruppe">
							<option value="" disabled>Del med …</option>
							{#each data.groups as g (g.id)}<option value={g.id}>{g.name}{g.kind === 'client' ? ' (kunde)' : ''}</option>{/each}
						</select>
						<button class="btn" type="submit" disabled={!shareTo}><Icon name="users" /> Del</button>
					</form>
				{/if}
				<form method="POST" action="?/bulk" use:enhance={submit({ onsuccess: done })} class="inline">
					{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
					<input type="hidden" name="op" value="move" />
					<select class="input small" name="target" bind:value={moveTo} aria-label="Flytt til mappe">
						<option value="__" disabled>Flytt til …</option>
						<option value="">Toppnivå</option>
						{#each data.folders as f (f.id)}<option value={f.id}>{' '.repeat(f.depth * 3)}{f.label}</option>{/each}
					</select>
					<button class="btn" type="submit" disabled={moveTo === '__'}><Icon name="move" /> Flytt</button>
				</form>
			{/if}
			<button class="btn ghost" type="button" onclick={() => ((selected = []), (confirmPublic = false))}>Fjern valg</button>
			{#if lightroomSelected && moveTo !== '__'}
				<p class="hint lr">
					{plural(lightroomSelected, 'element', 'elementer')} kommer fra Lightroom og flyttes tilbake neste gang du publiserer. Flytt dem i Lightroom i
					stedet.
				</p>
			{/if}
		</div>
	{/if}

	<div class="list" role="list">
		<div class="list-head">
			<label class="check">
				<input type="checkbox" checked={allVisibleSelected} onchange={toggleAll} disabled={!visible.length} aria-label="Velg alle som vises" />
			</label>
			<span class="faint">
				{#if flat}{plural(visible.length, 'treff', 'treff')}{:else}{plural(data.rows.length, 'element', 'elementer')}{/if}
			</span>
		</div>
		{#each visible as r (r.id)}
			<div class="row" role="listitem" class:sel={selected.includes(r.id)} style:--depth={flat ? 0 : r.depth}>
				<input class="pick" type="checkbox" checked={selected.includes(r.id)} onchange={() => toggle(r.id)} aria-label="Velg {r.name}" />
				<span class="indent">
					{#if !flat && r.type === 'folder' && r.hasChildren}
						<button
							class="chev"
							class:open={!collapsed.has(r.id)}
							type="button"
							onclick={() => toggleFolder(r.id)}
							aria-expanded={!collapsed.has(r.id)}
							aria-label="{collapsed.has(r.id) ? 'Vis' : 'Skjul'} innholdet i {r.name}"
						>
							<Icon name="chevron" size={14} />
						</button>
					{/if}
				</span>
				<a class="main" href="/admin/node/{r.id}">
					<span class="thumb" class:folder={r.type === 'folder'} style:background-color={r.cover?.color}>
						{#if r.cover}
							<img src={r.cover.src} srcset={r.cover.srcset} sizes="44px" alt="" loading="lazy" decoding="async" />
						{/if}
						{#if r.type === 'folder'}<span class="fbadge"><Icon name="folder" size={11} /></span>{:else if !r.cover}<Icon
								name="image"
								size={16}
							/>{/if}
					</span>
					<span class="text">
						<span class="name">{r.name}</span>
						<span class="sub">
							{#if flat && r.trail}{r.trail} · {/if}{r.type === 'album'
								? plural(r.photoCount, 'bilde', 'bilder')
								: plural(r.albumCount, 'album', 'album')}{#if r.type === 'album' && r.latest}{' '}· {formatMonth(r.latest)}{/if}
						</span>
					</span>
				</a>
				<span class="tags">
					<span class="pill {r.mode}" title={r.groups.length ? `Delt med ${r.groups.join(', ')}` : undefined}>
						<Icon name={MODE_ICON[r.mode]} size={12} />
						<span class="pt">{r.mode === 'client' && r.clients.length ? r.clients.join(', ') : MODE[r.mode]}</span>
					</span>
					{#if r.type === 'album' && r.allowDownload}<span class="badge" title="Nedlasting av originaler er på"><Icon name="download" size={12} /></span>{/if}
					{#if r.fromLightroom}<span class="badge lr-badge" title="Publiseres fra Lightroom">LR</span>{/if}
				</span>
				<a class="view" href={r.path} title="Vis på nettstedet" aria-label="Vis {r.name} på nettstedet"><Icon name="external" size={16} /></a>
			</div>
		{:else}
			<p class="none muted">Ingenting passer. <button class="linkish" onclick={() => ((filter = 'all'), (query = ''))}>Vis alt</button></p>
		{/each}
	</div>
{:else}
	<div class="empty">
		<p>Biblioteket er tomt.</p>
		<p class="muted">Lag et album her, eller publiser fra Lightroom – da opprettes mapper og album automatisk.</p>
	</div>
{/if}

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	h1 {
		font-size: 28px;
	}
	.head p {
		margin-top: 6px;
	}
	.buttons,
	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.create {
		display: grid;
		gap: 16px;
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
		margin-bottom: 24px;
	}
	.create h2 {
		font-size: 18px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
		gap: 14px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		margin-bottom: 14px;
	}
	.search {
		position: relative;
		flex: 1 1 260px;
		max-width: 420px;
	}
	.search :global(svg) {
		position: absolute;
		left: 12px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--faint);
		pointer-events: none;
	}
	.search .input {
		padding-left: 36px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 34px;
		padding: 0 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--muted);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.chip:hover {
		color: var(--text);
	}
	.chip.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.chip .n {
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}
	.bulk {
		position: sticky;
		top: 0;
		z-index: 6;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 10px;
		padding: 10px 12px;
		margin-bottom: 10px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-2) 92%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.35);
	}
	.bulk strong {
		margin-right: 4px;
	}
	.bulk form {
		margin: 0;
	}
	.bulk .lr {
		flex-basis: 100%;
	}
	.confirm span {
		font-size: 14px;
		color: var(--muted);
	}
	.input.small {
		min-height: 38px;
		width: auto;
		max-width: 220px;
		padding: 6px 10px;
		font-size: 14px;
	}
	.list {
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
		background: var(--surface);
	}
	.list-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}
	.row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-top: 1px solid var(--line);
	}
	.list-head + .row {
		border-top: 0;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.sel {
		background: rgba(233, 228, 218, 0.06);
	}
	.pick {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
		margin: 0;
	}
	.check input {
		margin: 0;
	}
	.indent {
		width: calc(var(--depth) * 20px + 22px);
		display: flex;
		justify-content: flex-end;
	}
	.chev {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		cursor: pointer;
		transition: transform 0.15s;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.chev:hover {
		background: var(--surface-3);
		color: var(--text);
	}
	.main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.thumb {
		position: relative;
		flex: none;
		width: 44px;
		height: 44px;
		border-radius: 8px;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: var(--surface-3);
		color: var(--faint);
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb.folder::after {
		content: '';
		position: absolute;
		inset: 0;
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
		border-radius: 8px;
	}
	.fbadge {
		position: absolute;
		left: 3px;
		bottom: 3px;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 5px;
		background: rgba(12, 12, 13, 0.75);
		color: var(--warn);
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.name {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.main:hover .name {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.sub {
		font-size: 13px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tags {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
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
		max-width: 220px;
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
	.lr-badge {
		font-size: 11px;
		letter-spacing: 0.02em;
	}
	.view {
		color: var(--faint);
		display: inline-grid;
		padding: 4px;
	}
	.view:hover {
		color: var(--text);
	}
	.none {
		padding: 22px 16px;
	}
	.linkish {
		border: 0;
		background: none;
		padding: 0;
		color: var(--text);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
	.empty {
		padding: 32px 0;
		display: grid;
		gap: 6px;
	}
	@media (max-width: 760px) {
		.row {
			grid-template-columns: auto auto minmax(0, 1fr) auto;
			gap: 8px;
			padding: 8px 10px;
		}
		.indent {
			width: calc(var(--depth) * 12px + 22px);
		}
		.view,
		.badge {
			display: none;
		}
		.pill {
			max-width: 110px;
		}
		.list-head {
			padding: 8px 10px;
		}
	}
</style>
