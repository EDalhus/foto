<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import SearchPalette from '$lib/components/SearchPalette.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { onMount } from 'svelte';

	let { data, children } = $props();
	const inAdmin = $derived(page.url.pathname.startsWith('/admin'));
	let palette = $state<SearchPalette>();
	let mac = $state(true);
	onMount(() => {
		mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	});
</script>

<div class="shell">
	<header class="top">
		<div class="wrap row">
			<a class="brand" href="/">{data.site.title}</a>
			<nav>
				{#if !inAdmin}
					<a
						class="search"
						href="/sok"
						aria-label="Søk"
						aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
						onclick={(e) => {
							if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
							e.preventDefault();
							palette?.show();
						}}
					>
						<Icon name="search" size={17} /> <span>Søk</span> <kbd>{mac ? '⌘' : 'Ctrl '}K</kbd>
					</a>
				{/if}
				{#if data.user?.isAdmin}
					{#if inAdmin}
						<a href="/">Til nettstedet</a>
					{:else}
						<a href="/admin">Administrer</a>
					{/if}
					<form method="POST" action="/logout">
						<button type="submit" class="linkish">Logg ut</button>
					</form>
				{:else if data.user}
					<span class="who">{data.user.name || data.user.email}</span>
					<form method="POST" action="/logout">
						<button type="submit" class="linkish">Logg ut</button>
					</form>
				{/if}
			</nav>
		</div>
	</header>

	<main>
		{@render children()}
	</main>

	{#if !inAdmin}<SearchPalette bind:this={palette} />{/if}
	<Toasts />

	<footer class="foot">
		<div class="wrap row">
			<span>© {new Date().getFullYear()} {data.site.title}</span>
			{#if !data.user}
				<a href="/login?next={encodeURIComponent(page.url.pathname)}">Logg inn</a>
			{/if}
		</div>
	</footer>
</div>

<style>
	.shell {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}
	main {
		flex: 1;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.top .row {
		height: 64px;
	}
	.brand {
		font-weight: 600;
		font-size: 17px;
		letter-spacing: -0.01em;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 18px;
		font-size: 14px;
		color: var(--muted);
	}
	nav a:hover,
	.linkish:hover {
		color: var(--text);
	}
	nav form {
		margin: 0;
	}
	.search {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.search kbd {
		font: inherit;
		font-size: 11px;
		line-height: 1;
		padding: 3px 5px;
		border: 1px solid var(--line);
		border-radius: 5px;
		color: var(--faint);
	}
	@media (max-width: 520px) {
		.search span,
		.search kbd {
			display: none;
		}
	}
	@media (hover: none) {
		.search kbd {
			display: none;
		}
	}
	.who {
		max-width: 40vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.linkish {
		border: 0;
		background: none;
		padding: 0;
		color: var(--muted);
		cursor: pointer;
		font-size: 14px;
	}
	.foot {
		margin-top: 96px;
		border-top: 1px solid var(--line);
		font-size: 13px;
		color: var(--faint);
	}
	.foot .row {
		height: 64px;
	}
	.foot a:hover {
		color: var(--text);
	}
</style>
