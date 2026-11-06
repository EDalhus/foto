<script lang="ts">
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { CardGroup, CardView, Grouping } from '$lib/types';
	import { formatMonth, plural } from '$lib/format';
	import CardGrid from './CardGrid.svelte';
	import Icon from './Icon.svelte';

	/**
	 * Innholdet i en mappe delt i kategorier (f.eks. båter etter rederi), vist slik administratoren har valgt:
	 *  - sections: en overskrift over hver kategori
	 *  - boxes:    hver kategori i sin egen ramme
	 *  - tags:     ett rutenett, kategorien står over navnet på hvert kort
	 *  - filter:   knapper øverst – én kategori om gangen
	 *  - rows:     én rad per kategori som blas sideveis
	 *  - stacks:   hver kategori som en bunke man åpner
	 * Valgt kategori (filter/bunker) står i adressen (?kategori=…), så lenken kan deles.
	 */
	let { grouping }: { grouping: Grouping } = $props();

	const groups = $derived(grouping.groups);
	const style = $derived(grouping.style);
	const all = $derived(groups.flatMap((g) => g.cards));
	const named = $derived(groups.filter((g) => g.id !== null));
	const rest = $derived(groups.find((g) => g.id === null)?.cards ?? []);

	const selected = $derived.by(() => {
		if (style !== 'filter' && style !== 'stacks') return null;
		const k = page.url.searchParams.get('kategori');
		return k ? (groups.find((g) => g.slug === k) ?? null) : null;
	});

	function hrefFor(slug: string | null) {
		const url = new URL(page.url);
		if (slug) url.searchParams.set('kategori', slug);
		else url.searchParams.delete('kategori');
		return url.pathname + url.search;
	}

	/** Filterknappene bytter visning uten å lage nye steg i historikken. */
	function filterTo(e: MouseEvent, slug: string | null) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		e.preventDefault();
		goto(hrefFor(slug), { replaceState: true, noScroll: true, keepFocus: true });
	}

	function countText(cards: CardView[]) {
		const folders = cards.filter((c) => c.type === 'folder').length;
		const albums = cards.length - folders;
		return [albums ? plural(albums, 'album', 'album') : '', folders ? plural(folders, 'mappe', 'mapper') : '']
			.filter(Boolean)
			.join(' og ');
	}
	const latestOf = (g: CardGroup) => Math.max(...g.cards.map((c) => c.latest));

	/** Tre lag i bunken: forsidene til de første albumene (gjentas hvis det er færre). */
	function layers(g: CardGroup) {
		const covers = g.cards.map((c) => c.cover);
		return [0, 1, 2].map((i) => covers[i % covers.length] ?? null);
	}

	// --- Rader: piler når raden er bredere enn skjermen ---
	function rowArrows(section: HTMLElement) {
		const list = section.querySelector<HTMLElement>('.grid');
		if (!list) return;
		const update = () => {
			section.classList.toggle('can-left', list.scrollLeft > 4);
			section.classList.toggle('can-right', list.scrollLeft + list.clientWidth < list.scrollWidth - 4);
		};
		update();
		list.addEventListener('scroll', update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(list);
		return { destroy: () => (list.removeEventListener('scroll', update), ro.disconnect()) };
	}
	function scrollRow(e: MouseEvent, dir: number) {
		const list = (e.currentTarget as HTMLElement).closest('section')?.querySelector<HTMLElement>('.grid');
		list?.scrollBy({ left: dir * list.clientWidth * 0.85, behavior: 'smooth' });
	}
</script>

{#snippet heading(g: CardGroup, tag: 'h2' | 'h3' = 'h2')}
	<header class="sec-head">
		<svelte:element this={tag} id="k-{g.slug}-h" class="sec-title">
			{#if g.color}<i class="cdot" style:background={g.color}></i>{/if}{g.name}
		</svelte:element>
		<span class="count">{countText(g.cards)}</span>
	</header>
	{#if g.description}<p class="sec-desc">{g.description}</p>{/if}
{/snippet}

{#if style === 'sections' || style === 'boxes'}
	{#if groups.length >= 3}
		<nav class="jump" aria-label="Hopp til kategori">
			{#each groups as g (g.slug)}
				<a href="#k-{g.slug}">{#if g.color}<i class="cdot" style:background={g.color}></i>{/if}{g.name}</a>
			{/each}
		</nav>
	{/if}
	<div class="sections" class:boxes={style === 'boxes'}>
		{#each groups as g (g.slug)}
			<section class="sec" id="k-{g.slug}" aria-labelledby="k-{g.slug}-h" style:--cat={g.color}>
				{@render heading(g)}
				<CardGrid cards={g.cards} level={3} min={style === 'boxes' ? 260 : 300} />
			</section>
		{/each}
	</div>
{:else if style === 'tags'}
	<CardGrid cards={all} showCategory />
{:else if style === 'filter'}
	<nav class="chips" aria-label="Vis kategori">
		<a href={hrefFor(null)} class:on={!selected} aria-current={!selected ? 'true' : undefined} onclick={(e) => filterTo(e, null)}>
			Alle <span class="n">{all.length}</span>
		</a>
		{#each groups as g (g.slug)}
			{@const on = selected?.slug === g.slug}
			<a href={hrefFor(g.slug)} class:on aria-current={on ? 'true' : undefined} onclick={(e) => filterTo(e, g.slug)}>
				{#if g.color}<i class="cdot" style:background={g.color}></i>{/if}{g.name} <span class="n">{g.cards.length}</span>
			</a>
		{/each}
	</nav>
	{#key selected?.slug ?? ''}
		<div class="filtered" in:fade={{ duration: 180 }}>
			{#if selected?.description}<p class="sec-desc">{selected.description}</p>{/if}
			<CardGrid cards={selected ? selected.cards : all} showCategory={!selected} />
		</div>
	{/key}
{:else if style === 'rows'}
	<div class="sections">
		{#each groups as g (g.slug)}
			<section class="sec rowsec" aria-labelledby="k-{g.slug}-h" use:rowArrows>
				<div class="row-head">
					{@render heading(g)}
					<div class="arrows">
						<button class="arrow prev" type="button" onclick={(e) => scrollRow(e, -1)} aria-label="Bla til venstre i {g.name}"><Icon name="left" size={18} /></button>
						<button class="arrow next" type="button" onclick={(e) => scrollRow(e, 1)} aria-label="Bla til høyre i {g.name}"><Icon name="right" size={18} /></button>
					</div>
				</div>
				<CardGrid cards={g.cards} level={3} variant="row" />
			</section>
		{/each}
	</div>
{:else if style === 'stacks'}
	{#if selected}
		<div class="opened" in:fade={{ duration: 180 }}>
			<a class="back" href={hrefFor(null)}><Icon name="back" size={16} /> Alle kategorier</a>
			<section class="sec" aria-labelledby="k-{selected.slug}-h">
				{@render heading(selected)}
				<CardGrid cards={selected.cards} level={3} />
			</section>
		</div>
	{:else}
		<CardGrid cards={rest} pad>
			{#snippet before()}
				{#each named as g (g.slug)}
					{@const pile = layers(g)}
					<li>
						<a class="stack" href={hrefFor(g.slug)} aria-label="{g.name}: {countText(g.cards)}">
							<div class="pile">
								{#each [2, 1, 0] as i (i)}
									{@const c = pile[i]}
									<div class="layer l{i}" style:background-color={c?.color ?? undefined}>
										{#if c}<img src={c.src} srcset={c.srcset} sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 33vw" alt="" loading="lazy" decoding="async" />{/if}
									</div>
								{/each}
								<span class="pile-count"><Icon name="folder" size={13} /> {countText(g.cards)}</span>
							</div>
							<div class="stack-text">
								<h2>{#if g.color}<i class="cdot" style:background={g.color}></i>{/if}{g.name}</h2>
								<p>{countText(g.cards)}<span class="sep">·</span>{formatMonth(latestOf(g))}</p>
							</div>
						</a>
					</li>
				{/each}
			{/snippet}
		</CardGrid>
	{/if}
{/if}

<style>
	.sections {
		display: grid;
		gap: clamp(44px, 5vw, 72px);
	}
	.sec {
		scroll-margin-top: 24px;
		min-width: 0;
	}
	.sec-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 14px;
		padding-bottom: 12px;
		margin-bottom: 20px;
		border-bottom: 1px solid var(--line);
	}
	.sec-title {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: clamp(20px, 2vw, 24px);
		font-weight: 600;
		letter-spacing: -0.015em;
	}
	.count {
		font-size: 14px;
		color: var(--faint);
	}
	.sec-desc {
		margin: -8px 0 20px;
		max-width: 70ch;
		color: var(--muted);
		white-space: pre-line;
	}
	.cdot {
		flex: none;
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 999px;
	}

	/* «Hopp til» over overskriftene når det er mange kategorier. */
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		margin: -6px 0 clamp(28px, 3vw, 40px);
		font-size: 14px;
	}
	.jump a {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		color: var(--muted);
	}
	.jump a:hover {
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.jump .cdot {
		width: 7px;
		height: 7px;
	}

	/* Bokser: hver kategori i en ramme, med et snev av kategorifargen. */
	.boxes {
		gap: clamp(18px, 2vw, 28px);
	}
	.boxes .sec {
		padding: clamp(16px, 2.2vw, 28px);
		border: 1px solid var(--line);
		border-radius: 18px;
		background: var(--surface);
		background: color-mix(in srgb, var(--cat, var(--surface)) 6%, var(--surface));
	}
	.boxes .sec-head {
		border-bottom: 0;
		padding-bottom: 0;
		margin-bottom: 18px;
	}

	/* Filterknapper: én rad som kan blas sideveis på mobil. */
	.chips {
		display: flex;
		gap: 8px;
		margin: 0 calc(-1 * var(--gutter)) clamp(22px, 2.5vw, 32px);
		padding: 2px var(--gutter);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.chips::-webkit-scrollbar {
		display: none;
	}
	.chips a {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		padding: 0 15px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
	}
	.chips a:hover {
		color: var(--text);
		border-color: #3a3a40;
	}
	.chips a.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.chips .n {
		font-variant-numeric: tabular-nums;
		color: var(--faint);
		font-weight: 400;
	}
	.chips a.on .n {
		color: color-mix(in srgb, var(--accent-ink) 60%, transparent);
	}
	.chips .cdot {
		width: 8px;
		height: 8px;
	}

	/* Rader: overskrift med piler (bare når raden er bredere enn skjermen, og ikke på berøringsskjerm). */
	.row-head {
		position: relative;
	}
	.row-head .sec-head {
		padding-right: 96px;
	}
	.arrows {
		position: absolute;
		right: 0;
		top: 0;
		display: flex;
		gap: 6px;
		visibility: hidden;
	}
	.rowsec:global(.can-left) .arrows,
	.rowsec:global(.can-right) .arrows {
		visibility: visible;
	}
	.arrow {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		opacity: 0.35;
		pointer-events: none;
		transition: opacity 0.15s;
	}
	.rowsec:global(.can-left) .prev,
	.rowsec:global(.can-right) .next {
		opacity: 1;
		pointer-events: auto;
	}
	.arrow:hover {
		background: var(--surface-2);
	}
	@media (hover: none) {
		.arrows {
			display: none;
		}
		.row-head .sec-head {
			padding-right: 0;
		}
	}

	/* Bunker: forsidene til albumene stablet bak hverandre; vifter seg litt ut når man holder over. */
	.stack {
		display: block;
	}
	.pile {
		position: relative;
		aspect-ratio: 3 / 2;
		margin-top: 20px;
	}
	.layer {
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--surface-2);
		/* Lagene bak krymper mot toppen og løftes, så kanten deres stikker opp over forsiden. */
		transform-origin: 50% 0;
		transition:
			transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1),
			filter 0.3s;
	}
	.layer img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.l1 {
		transform: translateY(-9px) scale(0.94);
		filter: brightness(0.55);
	}
	.l2 {
		transform: translateY(-17px) scale(0.88);
		filter: brightness(0.32);
	}
	.l0 {
		box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.45);
	}
	.stack:hover .l1 {
		transform: translateY(-12px) scale(0.94) rotate(-1.4deg);
	}
	.stack:hover .l2 {
		transform: translateY(-21px) scale(0.88) rotate(1.8deg);
	}
	.stack:hover .l0 img {
		transform: scale(1.03);
	}
	.pile-count {
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
	.stack-text {
		padding: 12px 2px 0;
	}
	.stack-text h2 {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.stack-text .cdot {
		width: 8px;
		height: 8px;
	}
	.stack-text p {
		margin-top: 3px;
		font-size: 14px;
		color: var(--muted);
	}
	.sep {
		margin: 0 6px;
		color: var(--faint);
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 18px;
		font-size: 14px;
		color: var(--muted);
	}
	.back:hover {
		color: var(--text);
	}
	@media (prefers-reduced-motion: reduce) {
		.layer,
		.layer img {
			transition: none;
		}
	}
</style>
