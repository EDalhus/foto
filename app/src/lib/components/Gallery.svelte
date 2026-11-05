<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { PhotoView } from '$lib/types';
	import { EASE_CLOSE, FULL, reducedMotion, reveal, thumbFrame, type Box } from '$lib/zoom';
	import JustifiedGrid from './JustifiedGrid.svelte';
	import Viewer from './Viewer.svelte';

	/**
	 * Rutenett + bildevisning. Bildet åpnes uten å laste siden på nytt (adressen blir /i/<id>), og når
	 * visningen lukkes, står siden der bildet du så sist ligger – også om du har bladd langt videre.
	 */
	let {
		photos,
		albumName = '',
		favorites = null,
		ontogglefavorite
	}: {
		photos: PhotoView[];
		albumName?: string;
		favorites?: Set<string> | null;
		ontogglefavorite?: (id: string) => void;
	} = $props();

	let root = $state<HTMLElement>();
	const openIndex = $derived(page.state.photoId ? photos.findIndex((p) => p.id === page.state.photoId) : -1);

	const thumb = (id: string) => root?.querySelector<HTMLElement>(`[data-photo="${CSS.escape(id)}"]`) ?? null;

	// Bildet som vises nå (eller sist) – siden ruller dit når visningen lukkes.
	let viewing: string | null = null;
	// Rulleposisjonen visningen lukket seg til (SvelteKit setter tilbake den gamle når historikken går tilbake).
	let restoreY: number | null = null;

	function open(id: string, e: MouseEvent) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		e.preventDefault();
		viewing = id;
		pushState(`/i/${id}`, { photoId: id });
	}

	function navigate(id: string) {
		viewing = id;
		replaceState(`/i/${id}`, { photoId: id });
	}

	function close() {
		restoreY = scrollY;
		history.back();
	}

	function focusThumb(id: string) {
		thumb(id)?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
	}

	// --- Lukket fra en egen bildelenke (/i/<id>): fly bildet tilbake på plass i albumet ---
	interface Landing {
		id: string;
		rect: Box | null;
		src: string | null;
		color: string | null;
		at: number;
	}
	let landing = $state<Landing | null>(null);
	let landImg = $state<HTMLImageElement>();
	let landBg = $state<HTMLDivElement>();

	async function land(l: Landing) {
		const t = thumb(l.id);
		if (!t) return;
		reveal(t);
		focusThumb(l.id);
		if (!l.rect || reducedMotion()) return;
		landing = l;
		await tick();
		if (!landImg) return;
		t.style.visibility = 'hidden';
		const done = () => {
			t.style.visibility = '';
			landing = null;
		};
		landBg?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', fill: 'forwards' });
		landImg
			.animate([FULL, thumbFrame(t.getBoundingClientRect(), l.rect)], { duration: 300, easing: EASE_CLOSE, fill: 'forwards' })
			.finished.then(done, done);
	}

	onMount(() => {
		if (page.state.photoId) viewing = page.state.photoId;

		// SvelteKit ruller tilbake til der siden var da bildet ble åpnet når historikken går tilbake. Vi venter til
		// neste bilderute (etter SvelteKit, men før noe tegnes) og ruller til bildet som ble vist sist.
		const onpop = () =>
			requestAnimationFrame(() => {
				if (page.state.photoId) {
					viewing = page.state.photoId;
					return;
				}
				const id = viewing;
				viewing = null;
				if (!id) return;
				if (restoreY !== null) scrollTo({ top: restoreY, left: scrollX, behavior: 'instant' });
				else {
					const t = thumb(id);
					if (t) reveal(t);
				}
				restoreY = null;
				focusThumb(id);
			});
		addEventListener('popstate', onpop);

		const l = page.state.landing as Landing | undefined;
		if (l && Date.now() - l.at < 10_000) {
			land(l);
			// Ikke spill av igjen om siden lastes på nytt.
			setTimeout(() => replaceState('', {}), 0);
		}
		return () => removeEventListener('popstate', onpop);
	});
</script>

<div bind:this={root}>
	<JustifiedGrid {photos} onopen={open} {favorites} {ontogglefavorite} />
</div>

{#if openIndex >= 0}
	<Viewer {photos} index={openIndex} {albumName} {favorites} {ontogglefavorite} {thumb} onnavigate={navigate} onclose={close} />
{/if}

{#if landing}
	<div class="landing" aria-hidden="true">
		<div class="land-bg" bind:this={landBg}></div>
		{#if landing.rect}
			<img
				bind:this={landImg}
				src={landing.src}
				alt=""
				style:left="{landing.rect.left}px"
				style:top="{landing.rect.top}px"
				style:width="{landing.rect.width}px"
				style:height="{landing.rect.height}px"
				style:background-color={landing.color}
			/>
		{/if}
	</div>
{/if}

<style>
	.landing {
		position: fixed;
		inset: 0;
		z-index: 100;
		pointer-events: none;
	}
	.land-bg {
		position: absolute;
		inset: 0;
		background: #070707;
	}
	.landing img {
		position: fixed;
		max-width: none;
		will-change: transform;
	}
</style>
