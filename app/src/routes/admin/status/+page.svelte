<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { formatBytes, formatLocal, plural } from '$lib/format';

	let { data } = $props();
	const h = $derived(data.health);
</script>

<svelte:head><title>Status – Administrer</title></svelte:head>

<h1>Status</h1>

<div class="cards">
	<div class="card">
		<span class="label">Lagring for originaler</span>
		<span class="value">
			{#if h.ok}<span class="badge ok"><Icon name="check" size={12} /> Tilkoblet</span>
			{:else if h.ok === false}<span class="badge bad">Utilgjengelig</span>
			{:else}<span class="badge">Ukjent</span>{/if}
		</span>
		<span class="faint small">{h.label}</span>
		{#if h.error}<span class="err small">{h.error}</span>{/if}
		<span class="faint small">Sjekket {formatLocal(h.checkedAt)}</span>
		<form method="POST" action="?/check" use:enhance><button class="btn" type="submit">Sjekk nå</button></form>
	</div>
	<div class="card">
		<span class="label">Venter på lagring</span>
		<span class="value big">{data.pending}</span>
		<span class="faint small">Originaler som ligger midlertidig på serveren og sendes til lagringen automatisk.</span>
	</div>
	<div class="card">
		<span class="label">Bibliotek</span>
		<span class="value big">{data.totals.photos.toLocaleString('nb-NO')}</span>
		<span class="faint small">{plural(data.albums, 'album', 'album')} · {formatBytes(data.totals.bytes)} originaler</span>
	</div>
	<div class="card">
		<span class="label">Database-backup</span>
		{#if data.backup.enabled}
			<span class="value">{data.backup.lastBackupAt ? formatLocal(data.backup.lastBackupAt) : 'Ikke tatt ennå'}</span>
			{#if data.backup.error}<span class="err small">{data.backup.error}</span>{/if}
			<span class="faint small">Tas automatisk én gang i døgnet.</span>
		{:else}
			<span class="value">Ikke satt opp</span>
		{/if}
	</div>
</div>

{#if data.deleteQueue}
	<p class="notice">{plural(data.deleteQueue, 'original', 'originaler')} står i kø for å slettes fra lagringen.</p>
{/if}

{#if data.errors.length}
	<h2>Feil ved lagring</h2>
	<ul class="errors">
		{#each data.errors as e (e.id)}
			<li><strong>{e.filename}</strong> <span class="faint">({e.original_attempts} forsøk)</span><br /><span class="err">{e.original_error}</span></li>
		{/each}
	</ul>
{/if}

<style>
	h1 {
		font-size: 28px;
		margin-bottom: 20px;
	}
	h2 {
		font-size: 18px;
		margin: 28px 0 10px;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr));
		gap: 14px;
		margin-bottom: 20px;
	}
	.card {
		display: grid;
		align-content: start;
		gap: 8px;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.label {
		font-size: 13px;
		color: var(--muted);
	}
	.value {
		font-weight: 500;
	}
	.big {
		font-size: 30px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.small {
		font-size: 13px;
		word-break: break-word;
	}
	.err {
		color: var(--danger);
	}
	.errors {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 8px;
		font-size: 14px;
	}
</style>
