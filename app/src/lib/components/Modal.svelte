<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/** Dialog over siden (<dialog> gir fokusfelle, Esc og bakgrunn). */
	let {
		open = $bindable(false),
		title,
		wide = false,
		children
	}: { open?: boolean; title: string; wide?: boolean; children: Snippet } = $props();

	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	class:wide
	aria-label={title}
	onclose={() => (open = false)}
	onclick={(e) => {
		if (e.target === dialog) open = false;
	}}
>
	{#if open}
		<div class="box">
			<header>
				<h2>{title}</h2>
				<button class="close" type="button" onclick={() => (open = false)} aria-label="Lukk"><Icon name="x" size={18} /></button>
			</header>
			<div class="body">{@render children()}</div>
		</div>
	{/if}
</dialog>

<style>
	dialog {
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 16px;
		background: var(--surface);
		color: var(--text);
		width: min(560px, calc(100vw - 24px));
		max-height: min(86dvh, 900px);
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
		overflow: hidden;
	}
	dialog.wide {
		width: min(1040px, calc(100vw - 24px));
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
		backdrop-filter: blur(4px);
	}
	dialog[open] {
		animation: pop 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
	}
	.box {
		display: flex;
		flex-direction: column;
		max-height: min(86dvh, 900px);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 16px 12px 20px;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		font-size: 17px;
	}
	.close {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.close:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.body {
		overflow-y: auto;
		padding: 16px 20px 20px;
	}
</style>
