<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Konto – Administrer</title></svelte:head>

<h1>Konto</h1>
<p class="muted lead">Innlogget som {data.email}. Bytter du passord, logges alle andre innlogginger ut.</p>

<form method="POST" action="?/password" use:enhance class="panel">
	<h2>Bytt passord</h2>
	{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
	{#if form?.saved}
		<p class="notice success" role="status">
			Passordet er byttet.{#if form.loggedOut} {form.loggedOut} annen innlogging ble logget ut.{/if}
		</p>
	{/if}
	<label class="field"><span>Nåværende passord</span><input class="input" type="password" name="current" autocomplete="current-password" required /></label>
	<label class="field"><span>Nytt passord (minst 12 tegn)</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="12" required /></label>
	<label class="field"><span>Gjenta nytt passord</span><input class="input" type="password" name="repeat" autocomplete="new-password" minlength="12" required /></label>
	<button class="btn primary" type="submit">Bytt passord</button>
</form>

<style>
	h1 {
		font-size: 28px;
	}
	.lead {
		margin: 6px 0 24px;
	}
	.panel {
		max-width: 440px;
		display: grid;
		gap: 14px;
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	h2 {
		font-size: 17px;
	}
</style>
