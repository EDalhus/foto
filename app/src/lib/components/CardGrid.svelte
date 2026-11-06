<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { CardView } from '$lib/types';
	import { formatMonth, plural } from '$lib/format';
	import Icon from './Icon.svelte';

	let {
		cards,
		level = 2,
		showCategory = false,
		variant = 'grid',
		min = 320,
		pad = false,
		before
	}: {
		cards: CardView[];
		/** Overskriftsnivå på kortene (3 når de står under en kategori-overskrift). */
		level?: 2 | 3;
		/** Vis kategorien over navnet («merkelapp»). */
		showCategory?: boolean;
		/** 'row': én rad som blas sideveis. */
		variant?: 'grid' | 'row';
		/** Minste kolonnebredde i rutenettet. */
		min?: number;
		/** Litt luft over kortene, så de står på linje med kategori-bunkene ved siden av. */
		pad?: boolean;
		/** Egne kort først i samme rutenett (f.eks. kategori-bunker). */
		before?: Snippet;
	} = $props();

	function meta(c: CardView) {
		if (c.type === 'folder') {
			return c.albumCount ? plural(c.albumCount, 'album', 'album') : 'Tom mappe';
		}
		return c.photoCount ? plural(c.photoCount, 'bilde', 'bilder') : 'Tomt album';
	}
	const sizes = $derived(
		variant === 'row' ? '(max-width: 640px) 80vw, 340px' : '(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 33vw'
	);
</script>

<ul class="grid" class:row={variant === 'row'} class:pad style:--min="{min}px">
	{@render before?.()}
	{#each cards as c, i (c.id)}
		<li>
			<a class="card" href={c.path}>
				<div class="cover" style:background-color={c.cover?.color ?? undefined}>
					{#if c.cover}
						<img
							src={c.cover.src}
							srcset={c.cover.srcset}
							{sizes}
							alt=""
							loading={i < 6 && variant === 'grid' ? 'eager' : 'lazy'}
							decoding="async"
						/>
					{:else}
						<div class="empty"><Icon name={c.type === 'folder' ? 'folder' : 'image'} size={28} /></div>
					{/if}
					{#if c.type === 'folder'}
						<span class="kind"><Icon name="folder" size={13} /> Mappe</span>
					{/if}
				</div>
				<div class="text">
					{#if showCategory && c.category}
						<span class="ctag">{#if c.category.color}<i style:background={c.category.color}></i>{/if}{c.category.name}</span>
					{/if}
					<svelte:element this={`h${level}`} class="name">{c.name}</svelte:element>
					<p>
						{meta(c)}{#if c.type === 'album' && c.photoCount}<span class="dot">·</span>{formatMonth(c.latest)}{/if}
						{#if c.isPrivate}<span class="badge private"><Icon name="lock" size={12} /> Privat</span>{/if}
					</p>
				</div>
			</a>
		</li>
	{/each}
</ul>

<style>
	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--min, 320px)), 1fr));
		gap: clamp(20px, 2.4vw, 36px) clamp(16px, 2vw, 28px);
	}
	/* Én rad som blas sideveis (med fingeren, styreflaten eller pilene over). Går helt ut til kanten på mobil. */
	.grid.row {
		grid-template-columns: none;
		grid-auto-flow: column;
		grid-auto-columns: min(78vw, 340px);
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: var(--gutter);
		margin-inline: calc(-1 * var(--gutter));
		padding: 0 var(--gutter) 6px;
		scrollbar-width: none;
	}
	.grid.row::-webkit-scrollbar {
		display: none;
	}
	.grid.row > :global(li) {
		scroll-snap-align: start;
	}
	.card {
		display: block;
	}
	.pad .card {
		padding-top: 20px;
	}
	.cover {
		position: relative;
		aspect-ratio: 3 / 2;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--surface-2);
	}
	.cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition:
			transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1),
			filter 0.3s;
	}
	.card:hover .cover img {
		transform: scale(1.03);
	}
	.empty {
		display: grid;
		place-items: center;
		height: 100%;
		color: var(--faint);
	}
	.kind {
		position: absolute;
		left: 10px;
		top: 10px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 500;
		background: rgba(12, 12, 13, 0.62);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		color: var(--text);
	}
	.text {
		padding: 12px 2px 0;
	}
	.name {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	/* Merkelappen: kategorien i små bokstaver over navnet. */
	.ctag {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 3px;
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ctag i {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 999px;
	}
	.text p {
		margin-top: 3px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		color: var(--muted);
	}
	.dot {
		color: var(--faint);
	}
</style>
