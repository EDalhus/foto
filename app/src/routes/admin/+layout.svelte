<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';

	let { children } = $props();
	const links = [
		{ href: '/admin', label: 'Bibliotek', icon: 'folder' },
		{ href: '/admin/tokens', label: 'Lightroom og API', icon: 'key' },
		{ href: '/admin/status', label: 'Status', icon: 'pulse' },
		{ href: '/admin/account', label: 'Konto', icon: 'lock' }
	];
	const active = (href: string) =>
		href === '/admin'
			? page.url.pathname === '/admin' || page.url.pathname.startsWith('/admin/node')
			: page.url.pathname.startsWith(href);
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap admin">
	<nav class="tabs" aria-label="Administrasjon">
		{#each links as l (l.href)}
			<a href={l.href} class:active={active(l.href)} aria-current={active(l.href) ? 'page' : undefined}>
				<Icon name={l.icon} size={16} />
				{l.label}
			</a>
		{/each}
	</nav>
	{@render children()}
</div>

<style>
	.admin {
		padding-top: 12px;
	}
	.tabs {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		border-bottom: 1px solid var(--line);
		margin-bottom: 28px;
		scrollbar-width: none;
	}
	.tabs a {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 10px 14px;
		font-size: 14px;
		color: var(--muted);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		white-space: nowrap;
	}
	.tabs a:hover {
		color: var(--text);
	}
	.tabs a.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
</style>
