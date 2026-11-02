<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatBytes } from '$lib/format';
	import Icon from './Icon.svelte';

	let { albumId }: { albumId: string } = $props();

	interface Item {
		key: number;
		file: File;
		progress: number;
		status: 'waiting' | 'uploading' | 'processing' | 'done' | 'error';
		error?: string;
	}

	const ACCEPT = 'image/jpeg,image/png,image/webp,image/tiff,image/avif,.jpg,.jpeg,.png,.webp,.tif,.tiff,.avif';
	const PARALLEL = 3;

	let items = $state<Item[]>([]);
	let dragging = $state(false);
	let input: HTMLInputElement | undefined = $state();
	let seq = 0;
	let active = 0;

	const done = $derived(items.filter((i) => i.status === 'done').length);
	const failed = $derived(items.filter((i) => i.status === 'error').length);
	const busy = $derived(items.some((i) => i.status === 'waiting' || i.status === 'uploading' || i.status === 'processing'));

	function add(files: FileList | File[]) {
		const list = [...files].filter((f) => f.size > 0);
		if (!list.length) return;
		items = [...items, ...list.map((file) => ({ key: ++seq, file, progress: 0, status: 'waiting' as const }))];
		pump();
	}

	function pump() {
		while (active < PARALLEL) {
			const next = items.find((i) => i.status === 'waiting');
			if (!next) break;
			active++;
			upload(next).finally(() => {
				active--;
				pump();
				if (!items.some((i) => i.status === 'waiting' || i.status === 'uploading' || i.status === 'processing')) {
					void invalidateAll();
				}
			});
		}
	}

	function upload(item: Item): Promise<void> {
		const update = (patch: Partial<Item>) => {
			const i = items.findIndex((x) => x.key === item.key);
			if (i >= 0) items[i] = { ...items[i], ...patch };
		};
		update({ status: 'uploading' });
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', `/api/v1/albums/${albumId}/photos`);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) update({ progress: e.loaded / e.total, status: e.loaded >= e.total ? 'processing' : 'uploading' });
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) update({ status: 'done', progress: 1 });
				else {
					let msg = `Feil ${xhr.status}`;
					try {
						msg = JSON.parse(xhr.responseText).error ?? msg;
					} catch {
						// ikke JSON
					}
					update({ status: 'error', error: msg });
				}
				resolve();
			};
			xhr.onerror = () => {
				update({ status: 'error', error: 'Nettverksfeil' });
				resolve();
			};
			const form = new FormData();
			form.append('file', item.file, item.file.name);
			xhr.send(form);
		});
	}

	function clearFinished() {
		items = items.filter((i) => i.status !== 'done');
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (e.dataTransfer?.files) add(e.dataTransfer.files);
	}
</script>

<div
	class="drop"
	class:dragging
	role="button"
	tabindex="0"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	{ondrop}
	onclick={() => input?.click()}
	onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input?.click())}
>
	<Icon name="upload" size={26} />
	<strong>Slipp bilder her, eller klikk for å velge</strong>
	<span class="muted">JPEG, PNG, WebP, TIFF eller AVIF. Originalen lagres i full oppløsning.</span>
	<input
		bind:this={input}
		type="file"
		accept={ACCEPT}
		multiple
		hidden
		onchange={(e) => {
			const t = e.currentTarget as HTMLInputElement;
			if (t.files) add(t.files);
			t.value = '';
		}}
	/>
</div>

{#if items.length}
	<div class="queue">
		<div class="summary">
			<span>
				{done} av {items.length} lastet opp{#if failed}, <span class="err">{failed} feilet</span>{/if}
				{#if busy}<span class="muted"> – ikke lukk siden</span>{/if}
			</span>
			{#if !busy}<button class="btn ghost" onclick={clearFinished}>Fjern ferdige</button>{/if}
		</div>
		<ul>
			{#each items as item (item.key)}
				<li class={item.status}>
					<span class="fname">{item.file.name}</span>
					<span class="size">{formatBytes(item.file.size)}</span>
					<span class="state">
						{#if item.status === 'waiting'}Venter
						{:else if item.status === 'uploading'}{Math.round(item.progress * 100)} %
						{:else if item.status === 'processing'}Behandler …
						{:else if item.status === 'done'}<Icon name="check" size={16} />
						{:else}{item.error}{/if}
					</span>
					<span class="bar" style:width="{item.progress * 100}%"></span>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.drop {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 28px 16px;
		border: 1.5px dashed #3a3a40;
		border-radius: 12px;
		background: var(--surface);
		text-align: center;
		cursor: pointer;
		color: var(--text);
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.drop:hover,
	.drop.dragging {
		border-color: var(--accent);
		background: var(--surface-2);
	}
	.drop span {
		font-size: 13px;
	}
	.queue {
		margin-top: 12px;
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
	}
	.summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 8px 8px 14px;
		font-size: 14px;
		background: var(--surface-2);
	}
	.err {
		color: var(--danger);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 260px;
		overflow-y: auto;
	}
	li {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 12px;
		padding: 8px 14px;
		font-size: 13px;
		border-top: 1px solid var(--line);
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.size {
		color: var(--faint);
	}
	.state {
		min-width: 70px;
		text-align: right;
		color: var(--muted);
		display: inline-flex;
		justify-content: flex-end;
	}
	li.done .state {
		color: var(--ok);
	}
	li.error .state {
		color: var(--danger);
	}
	.bar {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		background: var(--accent);
		transition: width 0.2s;
	}
	li.done .bar,
	li.error .bar {
		display: none;
	}
</style>
