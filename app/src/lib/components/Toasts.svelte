<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { dismiss, toasts } from '$lib/toasts.svelte';
	import Icon from './Icon.svelte';
</script>

<div class="toasts" aria-live="polite">
	{#each toasts.list as t (t.id)}
		<div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'} in:fly={{ y: 14, duration: 220 }} out:fade={{ duration: 160 }}>
			<span class="ico"><Icon name={t.kind === 'error' ? 'info' : 'check'} size={16} /></span>
			<span class="text">{t.text}</span>
			<button type="button" onclick={() => dismiss(t.id)} aria-label="Lukk meldingen"><Icon name="x" size={14} /></button>
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: fixed;
		z-index: 300;
		left: 50%;
		bottom: max(16px, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		width: min(440px, calc(100vw - 24px));
		display: grid;
		gap: 8px;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 10px 11px 14px;
		border-radius: 12px;
		background: #1f1f23;
		border: 1px solid #34343a;
		box-shadow: 0 12px 36px rgb(0 0 0 / 0.5);
		font-size: 14px;
		line-height: 1.4;
	}
	.ico {
		display: inline-grid;
		margin-top: 1px;
		color: var(--ok);
	}
	.error {
		border-color: rgba(255, 107, 94, 0.45);
	}
	.error .ico {
		color: var(--danger);
	}
	.info .ico {
		color: var(--muted);
	}
	.text {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	button {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--faint);
		cursor: pointer;
	}
	button:hover {
		color: var(--text);
		background: var(--surface-3);
	}
</style>
