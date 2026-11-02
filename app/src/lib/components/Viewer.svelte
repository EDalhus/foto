<script lang="ts">
	import { onMount } from 'svelte';
	import type { PhotoView } from '$lib/types';
	import { formatCamera, formatDateTime, formatExposure } from '$lib/format';
	import Icon from './Icon.svelte';

	let {
		photos,
		index,
		onnavigate,
		onclose,
		albumName = ''
	}: {
		photos: PhotoView[];
		index: number;
		onnavigate: (id: string) => void;
		onclose: () => void;
		albumName?: string;
	} = $props();

	const photo = $derived(photos[index]);
	const camera = $derived(photo ? formatCamera(photo.exif) : '');
	const exposure = $derived(photo ? formatExposure(photo.exif) : '');

	let showInfo = $state(false);
	let dialog: HTMLDivElement | undefined = $state();
	let stageW = $state(0);
	let stageH = $state(0);

	// Tilpass bildet til skjermen (aldri større enn originalen) så plassholderfargen har riktig form før bildet er lastet.
	const box = $derived.by(() => {
		if (!photo || !stageW || !stageH) return null;
		const scale = Math.min(stageW / photo.w, stageH / photo.h, 1);
		return { w: Math.round(photo.w * scale), h: Math.round(photo.h * scale) };
	});

	function go(delta: number) {
		const next = photos[index + delta];
		if (next) onnavigate(next.id);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === 'ArrowRight') go(1);
		else if (e.key === 'ArrowLeft') go(-1);
		else if (e.key === 'Escape') {
			if (showInfo && window.innerWidth < 900) showInfo = false;
			else onclose();
		} else if (e.key === 'i') showInfo = !showInfo;
		else return;
		e.preventDefault();
	}

	// Last naboene i forkant, så bla-ingen føles umiddelbar.
	$effect(() => {
		for (const d of [1, -1, 2]) {
			const p = photos[index + d];
			if (!p) continue;
			const img = new Image();
			img.sizes = '100vw';
			img.srcset = p.srcset;
			img.src = p.src;
		}
	});

	// Sveip på mobil: til siden = bla, ned = lukk.
	let start: { x: number; y: number } | null = null;
	function pointerdown(e: PointerEvent) {
		if (e.pointerType !== 'mouse') start = { x: e.clientX, y: e.clientY };
	}
	function pointerup(e: PointerEvent) {
		if (!start) return;
		const dx = e.clientX - start.x;
		const dy = e.clientY - start.y;
		start = null;
		if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
		else if (dy > 100 && dy > Math.abs(dx) * 1.4) onclose();
	}

	onMount(() => {
		dialog?.focus();
		const html = document.documentElement;
		const prev = html.style.overflow;
		html.style.overflow = 'hidden';
		return () => {
			html.style.overflow = prev;
		};
	});
</script>

<svelte:window {onkeydown} />

{#if photo}
	<div
		class="viewer"
		class:with-info={showInfo}
		role="dialog"
		aria-modal="true"
		aria-label={photo.title || albumName || 'Bilde'}
		tabindex="-1"
		bind:this={dialog}
	>
		<header class="bar">
			<button class="icon" onclick={onclose} aria-label="Lukk" title="Lukk (Esc)"><Icon name="x" size={22} /></button>
			<span class="count">{index + 1} / {photos.length}</span>
			<div class="actions">
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

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="stage"
			bind:clientWidth={stageW}
			bind:clientHeight={stageH}
			onpointerdown={pointerdown}
			onpointerup={pointerup}
			onpointercancel={() => (start = null)}
		>
			{#key photo.id}
				<img
					src={photo.src}
					srcset={photo.srcset}
					sizes="100vw"
					alt={photo.title || ''}
					class:fit={!box}
					style:width={box ? `${box.w}px` : undefined}
					style:height={box ? `${box.h}px` : undefined}
					style:background-color={photo.color}
					draggable="false"
				/>
			{/key}
			{#if index > 0}
				<button class="nav prev" onclick={() => go(-1)} aria-label="Forrige bilde"><Icon name="left" size={28} /></button>
			{/if}
			{#if index < photos.length - 1}
				<button class="nav next" onclick={() => go(1)} aria-label="Neste bilde"><Icon name="right" size={28} /></button>
			{/if}
		</div>

		{#if (photo.title || photo.caption) && !showInfo}
			<footer class="caption">
				{#if photo.title}<strong>{photo.title}</strong>{/if}
				{#if photo.caption}<span>{photo.caption}</span>{/if}
			</footer>
		{/if}

		{#if showInfo}
			<aside class="info" aria-label="Bildeinformasjon">
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
		background: #070707;
		color: var(--text);
		outline: none;
	}
	.bar {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		z-index: 2;
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
	.stage {
		grid-column: 1;
		position: relative;
		min-height: 0;
		display: grid;
		place-items: center;
		padding: 0 clamp(0px, 4vw, 72px) 12px;
		touch-action: pan-y pinch-zoom;
		overflow: hidden;
	}
	.stage img {
		max-width: 100%;
		max-height: 100%;
		user-select: none;
		-webkit-user-select: none;
	}
	.stage img.fit {
		width: 100%;
		height: 100%;
		object-fit: contain;
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
		.stage {
			padding: 0 0 8px;
		}
	}
</style>
