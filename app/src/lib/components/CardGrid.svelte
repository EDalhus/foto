<script lang="ts">
	import type { CardView } from '$lib/types';
	import { formatMonth, plural } from '$lib/format';
	import Icon from './Icon.svelte';

	let { cards }: { cards: CardView[] } = $props();

	function meta(c: CardView) {
		if (c.type === 'folder') {
			return c.albumCount ? plural(c.albumCount, 'album', 'album') : 'Tom mappe';
		}
		return c.photoCount ? plural(c.photoCount, 'bilde', 'bilder') : 'Tomt album';
	}
</script>

<ul class="grid">
	{#each cards as c, i (c.id)}
		<li>
			<a class="card" href={c.path}>
				<div class="cover" style:background-color={c.cover?.color ?? undefined}>
					{#if c.cover}
						<img
							src={c.cover.src}
							srcset={c.cover.srcset}
							sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 33vw"
							alt=""
							loading={i < 6 ? 'eager' : 'lazy'}
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
					<h2>{c.name}</h2>
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
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
		gap: clamp(20px, 2.4vw, 36px) clamp(16px, 2vw, 28px);
	}
	.card {
		display: block;
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
	h2 {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
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
