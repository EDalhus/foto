<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let busy = $state(false);
	const done = $derived(form?.done ?? (data.state === 'approved' ? 'approved' : data.state === 'denied' ? 'denied' : null));
</script>

<svelte:head>
	<title>Koble til Lightroom</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="card">
	{#if done === 'approved'}
		<h1>Lightroom er koblet til</h1>
		<p>Gå tilbake til Lightroom. Det tar bare et par sekunder før det står «Tilkoblet» der.</p>
		<p class="muted">Du kan lukke denne fanen.</p>
	{:else if done === 'denied'}
		<h1>Avbrutt</h1>
		<p>Lightroom ble ikke koblet til. Du kan lukke denne fanen.</p>
	{:else if data.state === 'missing'}
		<h1>Fant ikke forespørselen</h1>
		<p>Den har gått ut (etter 10 minutter) eller er allerede brukt. Trykk «Koble til Foto …» i Lightroom på nytt.</p>
	{:else}
		<h1>Koble til Lightroom?</h1>
		<p>Lightroom på <strong>{data.device}</strong> vil publisere bilder til nettstedet som <strong>{data.email}</strong>.</p>
		<div class="code">
			<span class="muted">Sjekk at Lightroom viser samme kode:</span>
			<strong>{data.code}</strong>
		</div>
		{#if !data.sameNetwork}
			<p class="notice warn">
				Forespørselen kom fra et annet nettverk enn denne nettleseren. Trykk bare «Koble til» hvis du selv nettopp trykket
				«Koble til Foto» i Lightroom.
			</p>
		{/if}
		{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
		<div class="actions">
			<form
				method="POST"
				action="?/approve"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
					};
				}}
			>
				<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Kobler til …' : 'Koble til'}</button>
			</form>
			<form method="POST" action="?/deny" use:enhance>
				<button class="btn" type="submit" disabled={busy}>Avbryt</button>
			</form>
		</div>
	{/if}
</div>

<style>
	.card {
		max-width: 440px;
		margin: clamp(40px, 10vh, 120px) auto 0;
		display: grid;
		gap: 16px;
		padding: 28px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--surface);
	}
	h1 {
		font-size: 24px;
	}
	.code {
		display: grid;
		gap: 6px;
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		text-align: center;
	}
	.code strong {
		font-size: 28px;
		letter-spacing: 0.12em;
		font-variant-numeric: tabular-nums;
	}
	.actions {
		display: flex;
		gap: 10px;
	}
	.btn {
		min-height: 42px;
	}
</style>
