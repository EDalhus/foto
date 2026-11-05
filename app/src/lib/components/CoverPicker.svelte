<script lang="ts">
	import { enhance } from '$app/forms';
	import { submit } from '$lib/submit';
	import Modal from './Modal.svelte';

	/** Velg forsidebilde blant bildene i albumet, eller i albumene i mappa. */
	let { open = $bindable(false), nodeId, current, isFolder = false }: { open?: boolean; nodeId: string; current: string | null; isFolder?: boolean } = $props();

	interface Section {
		album: { id: string; name: string; count: number };
		photos: { id: string; src: string; color: string | null; title: string }[];
	}
	let sections = $state<Section[] | null>(null);
	let failed = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		sections = null;
		failed = false;
		const ctrl = new AbortController();
		fetch(`/admin/node/${nodeId}/forside`, { signal: ctrl.signal })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((d) => (sections = d.sections))
			.catch((e) => {
				if (e.name !== 'AbortError') failed = true;
			});
		return () => ctrl.abort();
	});
</script>

<Modal bind:open title="Velg forsidebilde" wide>
	{#if failed}
		<p class="muted">Klarte ikke å hente bildene. Prøv igjen.</p>
	{:else if !sections}
		<p class="muted">Henter bildene …</p>
	{:else if !sections.length}
		<p class="muted">{isFolder ? 'Det er ingen bilder i albumene i mappa ennå.' : 'Albumet har ingen bilder ennå.'}</p>
	{:else}
		<form
			method="POST"
			action="/admin/node/{nodeId}?/setCover"
			use:enhance={submit({ busy: (b) => (busy = b), onsuccess: () => (open = false) })}
		>
			{#each sections as s (s.album.id)}
				<section>
					{#if isFolder}
						<h3>{s.album.name} <span class="faint">· {s.album.count > s.photos.length ? `viser ${s.photos.length} av ${s.album.count}` : s.album.count}</span></h3>
					{/if}
					<div class="grid">
						{#each s.photos as p (p.id)}
							<button
								type="submit"
								name="photo"
								value={p.id}
								class:current={p.id === current}
								style:background-color={p.color}
								disabled={busy}
								title={p.title}
								aria-label="Bruk {p.title} som forsidebilde"
							>
								<img src={p.src} alt="" loading="lazy" decoding="async" />
								{#if p.id === current}<span class="tag">Forside nå</span>{/if}
							</button>
						{/each}
					</div>
				</section>
			{/each}
		</form>
	{/if}
</Modal>

<style>
	section + section {
		margin-top: 22px;
	}
	h3 {
		font-size: 14px;
		font-weight: 600;
		margin-bottom: 10px;
	}
	h3 .faint {
		font-weight: 400;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
		gap: 8px;
	}
	button {
		position: relative;
		aspect-ratio: 1;
		padding: 0;
		border: 2px solid transparent;
		border-radius: 8px;
		overflow: hidden;
		cursor: pointer;
		background: var(--surface-2);
		transition:
			transform 0.12s,
			border-color 0.12s;
	}
	button:hover:not(:disabled) {
		border-color: var(--accent);
	}
	button:active:not(:disabled) {
		transform: scale(0.97);
	}
	button.current {
		border-color: var(--warn);
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.tag {
		position: absolute;
		left: 6px;
		bottom: 6px;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 11px;
		background: rgba(12, 12, 13, 0.75);
		color: var(--warn);
	}
</style>
