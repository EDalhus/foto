<script lang="ts" module>
	import type { Box } from '$lib/zoom';

	/** Det siden får vite når visningen lukkes. `rect`/`src` er bare satt med `handoff` (siden tar over animasjonen). */
	export interface CloseInfo {
		id: string;
		rect: Box | null;
		src: string | null;
		color: string | null;
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import type { PhotoView } from '$lib/types';
	import { formatCamera, formatDateTime, formatExposure } from '$lib/format';
	import { EASE_CLOSE, EASE_OPEN, FULL, loadedSrc, onScreen, reducedMotion, reveal, thumbFrame } from '$lib/zoom';
	import Icon from './Icon.svelte';

	let {
		photos,
		index,
		onnavigate,
		onclose,
		albumName = '',
		favorites = null,
		ontogglefavorite,
		thumb,
		handoff = false
	}: {
		photos: PhotoView[];
		index: number;
		onnavigate: (id: string) => void;
		onclose: (info: CloseInfo) => void;
		albumName?: string;
		/** Bilder gjesten har valgt. null = favoritter er ikke tilgjengelig her. */
		favorites?: Set<string> | null;
		ontogglefavorite?: (id: string) => void;
		/** Miniatyren til et bilde i rutenettet bak – bildet zoomer ut fra og tilbake til den. */
		thumb?: (id: string) => HTMLElement | null;
		/** Ikke animer lukkingen her; siden det lukkes til, gjør det (brukes på egne bildelenker). */
		handoff?: boolean;
	} = $props();

	const SLIDE_MS = 5000;

	const photo = $derived(photos[index]);
	const camera = $derived(photo ? formatCamera(photo.exif) : '');
	const exposure = $derived(photo ? formatExposure(photo.exif) : '');

	let showInfo = $state(false);
	let dialog = $state<HTMLDivElement>();
	let frame = $state<HTMLDivElement>();
	let backdrop = $state<HTMLDivElement>();
	let img = $state<HTMLImageElement>();
	let frameW = $state(0);
	let frameH = $state(0);
	let closing = $state(false);
	let draggingDown = $state(false);
	/** Retningen på siste bla (1 = neste, -1 = forrige) – styrer overgangen. 0 = ingen overgang. */
	let navDir = 0;

	// Tilpass bildet til flaten (aldri større enn originalen), så plassholderen har riktig form før bildet er lastet.
	const box = $derived.by(() => {
		if (!photo || !frameW || !frameH) return null;
		const scale = Math.min(frameW / photo.w, frameH / photo.h, 1);
		return { w: Math.round(photo.w * scale), h: Math.round(photo.h * scale) };
	});

	// Miniatyren (allerede lastet) vises under det store bildet til det er lastet.
	const placeholder = $derived.by(() => (photo ? loadedSrc(thumb?.(photo.id)) : null));

	function measure() {
		if (!frame) return;
		frameW = frame.clientWidth;
		frameH = frame.clientHeight;
	}

	/** Der bildet ligger når det står stille (uten dra-forskyvning). */
	function restingBox(): Box | null {
		if (!frame || !box) return null;
		const r = frame.getBoundingClientRect();
		return { left: r.left + (r.width - box.w) / 2, top: r.top + (r.height - box.h) / 2, width: box.w, height: box.h };
	}

	// Miniaturen skjules mens bildet «flyr» fra/til den, så det ikke ser dobbelt ut.
	let hidden: HTMLElement | null = null;
	function hideThumb(el: HTMLElement) {
		showThumb();
		hidden = el;
		el.style.visibility = 'hidden';
	}
	function showThumb() {
		if (hidden) hidden.style.visibility = '';
		hidden = null;
	}

	function go(delta: number) {
		const next = photos[index + delta];
		if (!next || closing) return;
		navDir = delta;
		onnavigate(next.id);
	}

	// --- Åpne og lukke ---

	function animateOpen() {
		const el = img;
		const to = restingBox();
		const reduce = reducedMotion();
		backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 120 : 280, easing: 'ease-out' });
		if (!el || !to || reduce) return;
		const t = photo ? thumb?.(photo.id) : null;
		if (t && onScreen(t)) {
			hideThumb(t);
			const a = el.animate([thumbFrame(t.getBoundingClientRect(), to), FULL], { duration: 340, easing: EASE_OPEN });
			a.finished.then(showThumb, showThumb);
		} else {
			el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 240, easing: EASE_OPEN });
		}
	}

	const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

	async function close() {
		if (closing || !photo) return;
		closing = true;
		playing = false;
		navDir = 0;
		if (document.fullscreenElement) {
			await document.exitFullscreen().catch(() => {});
			await nextFrame();
			measure();
			await tick();
		}
		const id = photo.id;
		const el = img;
		if (handoff) {
			const r = el?.getBoundingClientRect();
			onclose({
				id,
				rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
				src: el?.currentSrc || null,
				color: photo.color
			});
			return;
		}
		const reduce = reducedMotion();
		const to = restingBox();
		const t = thumb?.(id) ?? null;
		const duration = reduce ? 120 : 300;
		const bgFrom = backdrop ? getComputedStyle(backdrop).opacity : '1';
		backdrop?.animate([{ opacity: bgFrom }, { opacity: 0 }], { duration, easing: 'ease-in', fill: 'forwards' });
		let anim: Animation | undefined;
		if (el && to && t && !reduce) {
			// Rull siden bak så miniatyren er synlig, og zoom bildet tilbake dit.
			reveal(t);
			hideThumb(t);
			const from = el.style.transform ? { transform: el.style.transform, clipPath: FULL.clipPath } : FULL;
			el.style.transform = '';
			anim = el.animate([from, thumbFrame(t.getBoundingClientRect(), to)], { duration, easing: EASE_CLOSE, fill: 'forwards' });
		} else if (el) {
			if (t) reveal(t);
			anim = el.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
		}
		await anim?.finished.catch(() => {});
		onclose({ id, rect: null, src: null, color: null });
	}

	// Overgang når man blar: det nye bildet glir litt inn fra siden og tones opp.
	function enter(_node: Element) {
		const dir = navDir;
		if (!dir || reducedMotion()) return { duration: 0 };
		return { duration: 260, easing: cubicOut, css: (t: number, u: number) => `opacity:${t};transform:translateX(${u * dir * 40}px)` };
	}
	function leave(_node: Element) {
		const dir = navDir;
		if (!dir || reducedMotion()) return { duration: 0 };
		return { duration: 160, css: (t: number, u: number) => `opacity:${t};transform:translateX(${-u * dir * 40}px)` };
	}

	// --- Lysbildefremvisning ---
	let playing = $state(false);
	const isFav = $derived(!!favorites && !!photo && favorites.has(photo.id));

	function toggleSlideshow() {
		playing = !playing;
		if (playing) {
			showInfo = false;
			// Fullskjerm der nettleseren støtter det (ikke på iPhone – der er visningen allerede hele skjermen).
			if (document.fullscreenEnabled && !document.fullscreenElement) dialog?.requestFullscreen?.().catch(() => {});
		} else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	}

	// Neste bilde etter noen sekunder; starter på nytt fra begynnelsen etter det siste.
	$effect(() => {
		if (!playing || photos.length < 2) return;
		void index;
		const t = setTimeout(() => {
			navDir = 1;
			onnavigate((photos[index + 1] ?? photos[0]).id);
		}, SLIDE_MS);
		return () => clearTimeout(t);
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey || closing) return;
		if (e.key === 'ArrowRight') go(1);
		else if (e.key === 'ArrowLeft') go(-1);
		else if (e.key === 'Escape') {
			if (playing) toggleSlideshow();
			else if (showInfo && window.innerWidth < 900) showInfo = false;
			else close();
		} else if (e.key === 'i') showInfo = !showInfo;
		else if (e.key === ' ' || e.key === 'p') toggleSlideshow();
		else if (e.key === 'f' && favorites && photo) ontogglefavorite?.(photo.id);
		else return;
		e.preventDefault();
	}

	// Last naboene i forkant, så bla-ingen føles umiddelbar.
	$effect(() => {
		for (const d of [1, -1, 2]) {
			const p = photos[index + d];
			if (!p) continue;
			const pre = new Image();
			pre.sizes = '100vw';
			pre.srcset = p.srcset;
			pre.src = p.src;
		}
	});

	// --- Berøring: sveip til siden = bla, dra ned = lukk (bildet følger fingeren) ---
	let zoomed = false; // knipe-zoomet i nettleseren: la nettleseren panorere
	let lastPointer = 'mouse';
	let drag: { id: number; x: number; y: number; dx: number; dy: number; mode: '' | 'v' | 'h' } | null = null;

	function pointerdown(e: PointerEvent) {
		lastPointer = e.pointerType;
		if (e.pointerType === 'mouse' || zoomed || closing || !e.isPrimary) return;
		drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, mode: '' };
	}
	function pointermove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		drag.dx = e.clientX - drag.x;
		drag.dy = e.clientY - drag.y;
		if (!drag.mode) {
			if (drag.dy > 12 && drag.dy > Math.abs(drag.dx) * 1.2) {
				drag.mode = 'v';
				draggingDown = true;
			} else if (Math.abs(drag.dx) > 12) drag.mode = 'h';
		}
		if (drag.mode === 'v' && img) {
			const dy = Math.max(0, drag.dy);
			const s = 1 - Math.min(dy / 1400, 0.25);
			img.style.transform = `translate(${drag.dx * 0.6}px, ${dy}px) scale(${s})`;
			if (backdrop) backdrop.style.opacity = String(1 - Math.min(dy / 450, 0.85));
		}
	}
	function pointerup(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const d = drag;
		drag = null;
		draggingDown = false;
		if (d.mode === 'v') {
			if (d.dy > 90) close();
			else springBack();
		} else if (d.mode === 'h' && Math.abs(d.dx) > 50) go(d.dx < 0 ? 1 : -1);
	}
	function pointercancel() {
		if (drag?.mode === 'v') springBack();
		drag = null;
		draggingDown = false;
	}
	function springBack() {
		if (img?.style.transform) {
			const from = img.style.transform;
			img.style.transform = '';
			img.animate([{ transform: from }, { transform: 'none' }], { duration: 240, easing: EASE_OPEN });
		}
		if (backdrop?.style.opacity) {
			const from = backdrop.style.opacity;
			backdrop.style.opacity = '';
			backdrop.animate([{ opacity: from }, { opacity: 1 }], { duration: 240 });
		}
	}

	// Klikk med musa utenfor bildet lukker.
	function stageClick(e: MouseEvent) {
		if (lastPointer === 'mouse' && (e.target === e.currentTarget || e.target === frame)) close();
	}

	onMount(() => {
		measure();
		const ro = new ResizeObserver(measure);
		if (frame) ro.observe(frame);
		dialog?.focus({ preventScroll: true });
		const html = document.documentElement;
		const prev = html.style.overflow;
		html.style.overflow = 'hidden';
		// Når siden er knipe-zoomet, skal én finger panorere i stedet for å bla.
		const vv = window.visualViewport;
		const onZoom = () => (zoomed = !!vv && vv.scale > 1.01);
		vv?.addEventListener('resize', onZoom);
		tick().then(animateOpen);
		return () => {
			ro.disconnect();
			vv?.removeEventListener('resize', onZoom);
			html.style.overflow = prev;
			showThumb();
		};
	});
</script>

<svelte:window {onkeydown} />

{#if photo}
	<div
		class="viewer"
		class:with-info={showInfo}
		class:playing
		class:closing
		class:dragging={draggingDown}
		role="dialog"
		aria-modal="true"
		aria-label={photo.title || albumName || 'Bilde'}
		tabindex="-1"
		bind:this={dialog}
	>
		<div class="backdrop" bind:this={backdrop}></div>

		<header class="bar chrome">
			<button class="icon" onclick={close} aria-label="Lukk" title="Lukk (Esc)"><Icon name="x" size={22} /></button>
			<span class="count">{index + 1} / {photos.length}</span>
			<div class="actions">
				{#if favorites}
					<button
						class="icon fav"
						class:on={isFav}
						onclick={() => ontogglefavorite?.(photo.id)}
						aria-label={isFav ? 'Fjern fra favoritter' : 'Legg til i favoritter'}
						aria-pressed={isFav}
						title="Favoritt (f)"
					>
						<Icon name="heart" size={21} filled={isFav} />
					</button>
				{/if}
				{#if photos.length > 1}
					<button
						class="icon"
						class:on={playing}
						onclick={toggleSlideshow}
						aria-label={playing ? 'Stopp lysbildefremvisning' : 'Start lysbildefremvisning'}
						aria-pressed={playing}
						title="Lysbildefremvisning (mellomrom)"
					>
						<Icon name={playing ? 'pause' : 'play'} size={20} />
					</button>
				{/if}
				{#if photo.download}
					<a class="icon" href={photo.download} download aria-label="Last ned original" title="Last ned original">
						<Icon name="download" size={21} />
					</a>
				{/if}
				<button
					class="icon"
					class:on={showInfo}
					onclick={() => (showInfo = !showInfo)}
					aria-label="Bildeinformasjon"
					aria-pressed={showInfo}
					title="Info (i)"
				>
					<Icon name="info" size={21} />
				</button>
			</div>
		</header>

		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div
			class="stage"
			onpointerdown={pointerdown}
			onpointermove={pointermove}
			onpointerup={pointerup}
			onpointercancel={pointercancel}
			onclick={stageClick}
		>
			<div class="frame" bind:this={frame}>
				{#key photo.id}
					<img
						bind:this={img}
						in:enter
						out:leave
						src={photo.src}
						srcset={photo.srcset}
						sizes="100vw"
						alt={photo.title || ''}
						class:waiting={!box}
						style:width={box ? `${box.w}px` : undefined}
						style:height={box ? `${box.h}px` : undefined}
						style:background-color={photo.color}
						style:background-image={placeholder ? `url("${placeholder}")` : undefined}
						draggable="false"
					/>
				{/key}
			</div>
			{#if index > 0}
				<button class="nav prev chrome" onclick={() => go(-1)} aria-label="Forrige bilde"><Icon name="left" size={28} /></button>
			{/if}
			{#if index < photos.length - 1}
				<button class="nav next chrome" onclick={() => go(1)} aria-label="Neste bilde"><Icon name="right" size={28} /></button>
			{/if}
		</div>

		{#if playing}
			{#key photo.id}<div class="progress" style:animation-duration="{SLIDE_MS}ms"></div>{/key}
		{/if}

		{#if (photo.title || photo.caption) && !showInfo}
			<footer class="caption chrome">
				{#if photo.title}<strong>{photo.title}</strong>{/if}
				{#if photo.caption}<span>{photo.caption}</span>{/if}
			</footer>
		{/if}

		{#if showInfo}
			<aside class="info chrome" aria-label="Bildeinformasjon">
				<button class="icon close-info" onclick={() => (showInfo = false)} aria-label="Lukk info"><Icon name="x" size={20} /></button>
				{#if photo.title}<h2>{photo.title}</h2>{/if}
				{#if photo.caption}<p class="desc">{photo.caption}</p>{/if}
				<dl>
					{#if photo.takenAt}
						<dt>Tatt</dt>
						<dd>{formatDateTime(photo.takenAt)}</dd>
					{/if}
					{#if camera}
						<dt>Kamera</dt>
						<dd>{camera}</dd>
					{/if}
					{#if photo.exif.lens}
						<dt>Objektiv</dt>
						<dd>{photo.exif.lens}</dd>
					{/if}
					{#if exposure}
						<dt>Innstillinger</dt>
						<dd>{exposure}</dd>
					{/if}
					<dt>Størrelse</dt>
					<dd>{photo.w} × {photo.h} px</dd>
					<dt>Fil</dt>
					<dd class="file">{photo.filename}</dd>
				</dl>
				{#if photo.download}
					<a class="btn primary" href={photo.download} download><Icon name="download" /> Last ned original</a>
				{/if}
			</aside>
		{/if}
	</div>
{/if}

<style>
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		grid-template-rows: auto 1fr auto;
		grid-template-columns: 1fr auto;
		color: var(--text);
		outline: none;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		background: #070707;
		z-index: 0;
	}
	.bar {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		z-index: 2;
	}
	/* Knapper og tekst tones inn når visningen åpnes, og ut når den lukkes eller dras ned. */
	.chrome {
		animation: chrome-in 0.3s 0.12s backwards;
		transition: opacity 0.15s;
	}
	.closing .chrome,
	.dragging .chrome {
		opacity: 0 !important;
		pointer-events: none;
	}
	.closing {
		pointer-events: none;
	}
	@keyframes chrome-in {
		from {
			opacity: 0;
		}
	}
	.count {
		flex: 1;
		text-align: center;
		font-size: 14px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.actions {
		display: flex;
		gap: 4px;
	}
	.icon {
		display: inline-grid;
		place-items: center;
		width: 42px;
		height: 42px;
		border-radius: 999px;
		border: 0;
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.icon:hover,
	.icon.on {
		background: rgba(255, 255, 255, 0.1);
	}
	.icon.fav.on {
		color: #ff6b81;
		background: transparent;
	}
	.icon.fav:hover {
		background: rgba(255, 255, 255, 0.1);
	}
	/* Under fremvisning: skjul alt annet enn bildet til musa beveges eller man trykker på skjermen. */
	.playing .bar,
	.playing .caption {
		opacity: 0;
		transition: opacity 0.4s;
	}
	.playing:hover .bar,
	.playing:focus-within .bar {
		opacity: 1;
	}
	.playing .nav {
		display: none;
	}
	.progress {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		width: 100%;
		background: rgba(255, 255, 255, 0.5);
		transform-origin: left;
		animation-name: grow;
		animation-timing-function: linear;
		z-index: 4;
	}
	@keyframes grow {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}
	.stage {
		grid-column: 1;
		position: relative;
		min-height: 0;
		z-index: 1;
		/* Knipe-zoom håndteres av nettleseren; én finger (sveip og dra) håndterer vi selv. */
		touch-action: pinch-zoom;
	}
	.frame {
		position: absolute;
		inset: 0 clamp(0px, 4vw, 72px) 12px;
		display: grid;
		place-items: center;
	}
	.frame img {
		grid-area: 1 / 1;
		max-width: none;
		background-size: 100% 100%;
		user-select: none;
		-webkit-user-select: none;
		will-change: transform;
	}
	.frame img.waiting {
		visibility: hidden;
	}
	.nav {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		border: 0;
		border-radius: 999px;
		background: rgba(20, 20, 22, 0.55);
		color: var(--text);
		cursor: pointer;
		opacity: 0.75;
		transition:
			opacity 0.15s,
			background 0.15s;
	}
	.nav:hover {
		opacity: 1;
		background: rgba(40, 40, 44, 0.8);
	}
	.prev {
		left: 12px;
	}
	.next {
		right: 12px;
	}
	.caption {
		grid-column: 1;
		padding: 4px 20px 18px;
		text-align: center;
		font-size: 14px;
		color: var(--muted);
		display: grid;
		gap: 2px;
		max-width: 900px;
		justify-self: center;
		z-index: 1;
	}
	.caption strong {
		color: var(--text);
		font-weight: 500;
	}
	.info {
		grid-column: 2;
		grid-row: 2 / 4;
		width: 340px;
		overflow-y: auto;
		padding: 8px 24px 24px;
		border-left: 1px solid var(--line);
		background: var(--surface);
		position: relative;
		z-index: 2;
	}
	.close-info {
		display: none;
	}
	.info h2 {
		font-size: 19px;
		margin: 6px 0 8px;
	}
	.desc {
		color: var(--muted);
		white-space: pre-line;
		margin-bottom: 8px;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 16px;
		margin: 16px 0 22px;
		font-size: 14px;
	}
	dt {
		color: var(--faint);
	}
	dd {
		margin: 0;
	}
	.file {
		word-break: break-all;
	}
	@media (max-width: 900px) {
		.viewer.with-info {
			grid-template-columns: 1fr;
		}
		.info {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			width: auto;
			max-height: 70vh;
			border-left: 0;
			border-top: 1px solid var(--line);
			border-radius: 16px 16px 0 0;
			z-index: 3;
			padding-top: 18px;
		}
		.close-info {
			display: inline-grid;
			position: absolute;
			right: 10px;
			top: 10px;
		}
		.nav {
			display: none;
		}
		.frame {
			inset: 0 0 8px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.chrome {
			animation: none;
		}
	}
</style>
