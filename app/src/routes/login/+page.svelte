<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head>
	<title>Logg inn</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap">
	<form
		method="POST"
		class="card"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update();
				busy = false;
			};
		}}
	>
		<h1>Logg inn</h1>
		{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
		<label class="field">
			<span>E-post</span>
			<input class="input" type="email" name="email" autocomplete="username" required value={form?.email ?? ''} />
		</label>
		<label class="field">
			<span>Passord</span>
			<input class="input" type="password" name="password" autocomplete="current-password" required />
		</label>
		<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Logger inn …' : 'Logg inn'}</button>
	</form>
</div>

<style>
	.card {
		max-width: 380px;
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
	.btn {
		margin-top: 4px;
		min-height: 42px;
	}
</style>
