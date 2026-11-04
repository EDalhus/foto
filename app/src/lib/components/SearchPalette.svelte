<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { tick } from 'svelte';
	import type { SearchHit } from '$lib/types';
	import Icon from './Icon.svelte';

	/** Søkeboksen som legger seg over siden. Åpnes med ⌘K / Ctrl+K, «/» eller show() (Søk-knappen). */
	let open = $state(false);

	interface Result {
		q: string;
		nodes: SearchHit[];
		photos: SearchHit[];
		more: boolean;
	}

	let q = $state('');
	let result = $state<Result | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let active = $state(0);
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLElement>();

	const cache = new Map<string, Result>();
	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let returnFocus: HTMLElement | null = null;

	const hits = $derived(result ? [...result.nodes, ...result.photos] : []);
	const showAll = $derived(!!result?.q && (result.photos.length > 0 || result.more));
	/** Antall rader man kan gå mellom med piltastene (treff + «Vis alle»). */
	const rows = $derived(hits.length + (showAll ? 1 : 0));
	const allHref = $derived(`/sok?q=${encodeURIComponent(result?.q ?? '')}`);

	async function load(query: string) {
		const key = query.trim();
		const hit = cache.get(key);
		if (hit) {
			result = hit;
			loading = false;
			failed = false;
			active = 0;
			return;
		}
		controller?.abort();
		controller = new AbortController();
		loading = true;
		try {
			const res = await fetch(`/api/v1/search?q=${encodeURIComponent(key)}`, { signal: controller.signal });
			if (!res.ok) throw new Error(String(res.status));
			const data = (await res.json()) as Result;
			cache.set(key, data);
			if (q.trim() === key) {
				result = data;
				active = 0;
				failed = false;
			}
		} catch (err) {
			if ((err as Error).name !== 'AbortError') failed = true;
		} finally {
			if (q.trim() === key) loading = false;
		}
	}

	function oninput() {
		clearTimeout(timer);
		const key = q.trim();
		if (cache.has(key)) load(key);
		else timer = setTimeout(() => load(key), 110);
	}

	export async function show() {
		if (open) return;
		returnFocus = document.activeElement as HTMLElement | null;
		open = true;
		cache.clear(); // tilgang kan ha endret seg siden sist
		load(q);
		await tick();
		input?.focus();
		input?.select();
	}

	function hide() {
		if (!open) return;
		open = false;
		clearTimeout(timer);
		controller?.abort();
		returnFocus?.focus?.();
	}

	// Ikke la siden bak rulle mens boksen er oppe.
	$effect(() => {
		if (!open) return;
		const prev = document.documentElement.style.overflow;
		document.documentElement.style.overflow = 'hidden';
		return () => {
			document.documentElement.style.overflow = prev;
		};
	});

	afterNavigate(() => {
		if (open) {
			open = false;
			clearTimeout(timer);
		}
	});

	function go(i: number) {
		const href = i < hits.length ? hits[i]?.href : showAll ? allHref : null;
		if (!href) return;
		hide();
		goto(href);
	}

	async function move(delta: number) {
		if (!rows) return;
		active = (active + delta + rows) % rows;
		await tick();
		list?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function onWindowKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			if (open) hide();
			else show();
			return;
		}
		if (open || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		e.preventDefault();
		show();
	}

	/** Alle taster i boksen stopper her, så bildevisningen bak ikke reagerer på dem. */
	function onBoxKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return; // håndteres av vinduet
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			hide();
		} else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
			e.preventDefault();
			move(1);
		} else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
			e.preventDefault();
			move(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (e.metaKey || e.ctrlKey) {
				const href = active < hits.length ? hits[active]?.href : allHref;
				if (href) window.open(href, '_blank');
			} else go(active);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			input?.focus();
		}
	}

	function onclick(e: MouseEvent, i: number) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		go(i);
	}

	const icon = (h: SearchHit) => (h.kind === 'folder' ? 'folder' : 'image');
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="backdrop" onclick={hide}></div>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="box" role="dialog" aria-modal="true" aria-label="Søk" tabindex="-1" onkeydown={onBoxKey}>
		<div class="field">
			<Icon name="search" size={20} />
			<input
				bind:this={input}
				bind:value={q}
				{oninput}
				type="text"
				placeholder="Søk i album og bilder …"
				aria-label="Søk"
				aria-controls="search-results"
				aria-activedescendant={rows ? `search-row-${active}` : undefined}
				role="combobox"
				aria-expanded="true"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="go"
			/>
			{#if loading}<span class="spinner" aria-hidden="true"></span>{/if}
			<button class="esc" type="button" onclick={hide} aria-label="Lukk">Esc</button>
		</div>

		<div class="results" id="search-results" role="listbox" bind:this={list}>
			{#if failed && !hits.length}
				<p class="empty">Søket feilet. Prøv igjen.</p>
			{:else if result && !hits.length && result.q}
				<p class="empty">Fant ingenting for «{result.q}».</p>
			{:else if result && !hits.length}
				<p class="empty">Ingenting å vise ennå.</p>
			{/if}

			{#each hits as h, i (h.kind + h.id)}
				{#if result && i === result.nodes.length && result.photos.length}
					<p class="label">Bilder</p>
				{/if}
				<a
					href={h.href}
					class="row"
					class:on={i === active}
					class:photo={h.kind === 'photo'}
					role="option"
					aria-selected={i === active}
					id="search-row-{i}"
					data-row={i}
					tabindex="-1"
					onmousemove={() => (active = i)}
					onclick={(e) => onclick(e, i)}
				>
					<span class="thumb" style:background-color={h.thumb?.color ?? undefined}>
						{#if h.thumb}
							<img src={h.thumb.src} srcset={h.thumb.srcset} sizes="56px" alt="" loading="lazy" decoding="async" />
						{:else}
							<Icon name={icon(h)} size={20} />
						{/if}
					</span>
					<span class="text">
						<span class="name">{h.name}{#if h.isPrivate}<Icon name="lock" size={13} />{/if}</span>
						<span class="meta">{h.meta}</span>
					</span>
				</a>
			{/each}

			{#if showAll}
				<a
					href={allHref}
					class="row all"
					class:on={active === hits.length}
					role="option"
					aria-selected={active === hits.length}
					id="search-row-{hits.length}"
					data-row={hits.length}
					tabindex="-1"
					onmousemove={() => (active = hits.length)}
					onclick={(e) => onclick(e, hits.length)}
				>
					<span class="thumb"><Icon name="search" size={18} /></span>
					<span class="text"><span class="name">Vis alle treff for «{result?.q}»</span></span>
				</a>
			{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgb(0 0 0 / 0.55);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: fade 0.12s ease-out;
	}
	.box {
		position: fixed;
		z-index: 201;
		top: min(12vh, 120px);
		left: 50%;
		transform: translateX(-50%);
		width: min(640px, calc(100vw - 32px));
		max-height: min(640px, calc(100dvh - min(12vh, 120px) - 24px));
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 16px;
		box-shadow:
			0 24px 80px rgb(0 0 0 / 0.6),
			0 0 0 1px rgb(255 255 255 / 0.03) inset;
		overflow: hidden;
		animation: pop 0.14s cubic-bezier(0.2, 0.7, 0.2, 1);
		outline: none;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 14px 0 20px;
		height: 60px;
		flex: none;
		border-bottom: 1px solid var(--line);
		color: var(--muted);
	}
	.field input {
		flex: 1;
		min-width: 0;
		height: 100%;
		border: 0;
		outline: none;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 17px;
	}
	.field input::placeholder {
		color: var(--faint);
	}
	.esc {
		flex: none;
		font: inherit;
		font-size: 12px;
		color: var(--muted);
		background: none;
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 3px 8px;
		cursor: pointer;
	}
	.esc:hover {
		color: var(--text);
		border-color: var(--surface-3);
	}
	.spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid var(--surface-3);
		border-top-color: var(--muted);
		animation: spin 0.7s linear infinite;
	}
	.results {
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px;
	}
	.label {
		margin: 10px 12px 4px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--faint);
	}
	.empty {
		margin: 0;
		padding: 28px 16px;
		text-align: center;
		color: var(--muted);
		font-size: 14px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 8px 10px;
		border-radius: 10px;
		color: var(--text);
		scroll-margin: 8px;
	}
	.row.on {
		background: var(--surface-2);
	}
	.thumb {
		flex: none;
		width: 56px;
		height: 56px;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-2);
		display: grid;
		place-items: center;
		color: var(--faint);
	}
	.row.on .thumb:not(:has(img)) {
		background: var(--surface-3);
	}
	.photo .thumb {
		width: 44px;
		height: 44px;
		margin: 0 6px;
		border-radius: 6px;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.text {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 16px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name :global(svg) {
		flex: none;
		color: var(--faint);
	}
	.meta {
		font-size: 14px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.all .name {
		font-size: 15px;
		color: var(--muted);
	}
	.all.on .name {
		color: var(--text);
	}
	@media (max-width: 520px) {
		.box {
			top: 8px;
			max-height: calc(100dvh - 16px);
		}
		.thumb {
			width: 48px;
			height: 48px;
		}
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateX(-50%) scale(0.98);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.box {
			animation: none;
		}
	}
</style>
