<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { plural } from '$lib/format';

	let { data, form } = $props();
	let showCreate = $state(false);
	let createType = $state<'album' | 'folder'>('album');
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

{#if form?.error}<p class="notice error">{form.error}</p>{/if}

{#if showCreate}
	<form method="POST" action="?/create" class="create" use:enhance>
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
						<option value={f.id}>{'   '.repeat(f.depth)}{f.label}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				<span>Synlighet</span>
				<select class="input" name="visibility">
					<option value="public">Offentlig</option>
					<option value="private">Privat – bare innloggede</option>
				</select>
			</label>
		</div>
		{#if createType === 'album'}
			<label class="check"><input type="checkbox" name="allowDownload" /> Tillat nedlasting av originaler i full oppløsning</label>
		{/if}
		<div class="buttons">
			<button class="btn primary" type="submit">Opprett</button>
			<button class="btn ghost" type="button" onclick={() => (showCreate = false)}>Avbryt</button>
		</div>
	</form>
{/if}

{#if data.rows.length}
	<ul class="tree">
		{#each data.rows as r (r.id)}
			<li style:--depth={r.depth}>
				<a class="name" href="/admin/node/{r.id}">
					<span class="ico" class:folder={r.type === 'folder'}><Icon name={r.type === 'folder' ? 'folder' : 'image'} size={17} /></span>
					<span class="label">{r.name}</span>
				</a>
				<span class="info">
					{#if r.type === 'album'}{plural(r.photoCount, 'bilde', 'bilder')}{:else}{plural(r.albumCount, 'album', 'album')}{/if}
				</span>
				<span class="tags">
					{#if r.visibility === 'private'}
						<span class="badge private"><Icon name="lock" size={12} /> Privat</span>
					{:else if r.effectivePrivate}
						<span class="badge private" title="Ligger i en privat mappe"><Icon name="lock" size={12} /> Privat (arvet)</span>
					{/if}
					{#if r.type === 'album' && r.allowDownload}<span class="badge"><Icon name="download" size={12} /> Nedlasting</span>{/if}
					{#if r.fromLightroom}<span class="badge" title="Styres fra Lightroom">Lightroom</span>{/if}
				</span>
				<a class="view" href={r.path} title="Vis på nettstedet"><Icon name="external" size={16} /></a>
			</li>
		{/each}
	</ul>
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
		margin-bottom: 24px;
	}
	h1 {
		font-size: 28px;
	}
	.head p {
		margin-top: 6px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
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
	.tree {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
	}
	.tree li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		align-items: center;
		gap: 14px;
		padding: 10px 14px 10px calc(14px + var(--depth) * 22px);
		border-top: 1px solid var(--line);
		background: var(--surface);
	}
	.tree li:first-child {
		border-top: 0;
	}
	.tree li:hover {
		background: var(--surface-2);
	}
	.name {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.ico {
		color: var(--muted);
		display: inline-grid;
	}
	.ico.folder {
		color: var(--warn);
	}
	.info {
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
	}
	.tags {
		display: flex;
		gap: 6px;
	}
	.view {
		color: var(--faint);
		display: inline-grid;
	}
	.view:hover {
		color: var(--text);
	}
	.empty {
		padding: 32px 0;
		display: grid;
		gap: 6px;
	}
	@media (max-width: 700px) {
		.tree li {
			grid-template-columns: minmax(0, 1fr) auto;
			padding-left: calc(12px + var(--depth) * 14px);
		}
		.tags,
		.view {
			display: none;
		}
	}
</style>
