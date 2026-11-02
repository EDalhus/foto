<script lang="ts">
	import type { PhotoView } from '$lib/types';

	let {
		photos,
		onopen
	}: {
		photos: PhotoView[];
		onopen: (id: string, event: MouseEvent) => void;
	} = $props();

	// Radhøyde styres i CSS (--row). Disse brukes bare til å velge riktig bildestørrelse.
	const sizesFor = (ar: number) => `(max-width: 700px) ${Math.ceil(ar * 170)}px, ${Math.ceil(ar * 340)}px`;
</script>

<!--
	«Justified» rutenett uten JavaScript: hvert bilde vokser i forhold til bredde/høyde-forholdet sitt,
	så radene fylles helt ut og ingen bilder beskjæres mer enn noen få prosent.
-->
<div class="jg">
	{#each photos as p, i (p.id)}
		{@const ar = p.w / p.h}
		<a
			href="/i/{p.id}"
			class="item"
			style:flex-grow={ar}
			style:flex-basis="calc({ar} * var(--row))"
			style:background-color={p.color}
			onclick={(e) => onopen(p.id, e)}
			aria-label={p.title || `Bilde ${i + 1}`}
		>
			<i style:padding-bottom="{(100 / ar).toFixed(4)}%"></i>
			<img
				src={p.src}
				srcset={p.srcset}
				sizes={sizesFor(ar)}
				alt={p.title || ''}
				width={p.w}
				height={p.h}
				loading={i < 12 ? 'eager' : 'lazy'}
				decoding="async"
			/>
		</a>
	{/each}
</div>

<style>
	.jg {
		--row: 300px;
		--gap: 6px;
		display: flex;
		flex-wrap: wrap;
		gap: var(--gap);
	}
	.jg::after {
		content: '';
		flex-grow: 1000000000;
	}
	.item {
		position: relative;
		display: block;
		overflow: hidden;
		border-radius: 3px;
		background: var(--surface-2);
	}
	.item i {
		display: block;
	}
	.item img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: opacity 0.2s;
	}
	.item:hover img {
		opacity: 0.88;
	}
	@media (max-width: 1100px) {
		.jg {
			--row: 230px;
		}
	}
	@media (max-width: 700px) {
		.jg {
			--row: 150px;
			--gap: 4px;
		}
	}
</style>
