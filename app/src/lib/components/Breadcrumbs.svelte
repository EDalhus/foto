<script lang="ts">
	import type { Crumb } from '$lib/types';

	let { crumbs, root = { name: 'Hjem', path: '/' } }: { crumbs: Crumb[]; root?: Crumb | null } = $props();
	const all = $derived(root ? [root, ...crumbs] : crumbs);
</script>

{#if all.length}
	<nav class="crumbs" aria-label="Brødsmuler">
		{#each all as c, i (c.path)}
			{#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
			<a href={c.path}>{c.name}</a>
		{/each}
	</nav>
{/if}

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		color: var(--muted);
	}
	.crumbs a:hover {
		color: var(--text);
	}
	.sep {
		color: var(--faint);
	}
</style>
