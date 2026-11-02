<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let busy = $state(false);
</script>

<svelte:head>
	<title>Logg inn</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap">
	<div class="card">
		{#if data.valid && !form?.expired}
			<h1>{data.name ? `Hei ${data.name}!` : 'Hei!'}</h1>
			<p>{data.invite ? 'Bildene er klare.' : 'Du er nesten inne.'} Trykk på knappen for å logge inn som <strong>{data.email}</strong>.</p>
			<form
				method="POST"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
					};
				}}
			>
				<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Logger inn …' : data.invite ? 'Se bildene' : 'Logg inn'}</button>
			</form>
		{:else}
			<h1>Lenken virker ikke lenger</h1>
			<p>Den er allerede brukt eller har gått ut. Du kan få en ny på e-post.</p>
			<a class="btn primary" href="/login">Få en ny lenke</a>
		{/if}
	</div>
</div>

<style>
	.card {
		max-width: 400px;
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
		min-height: 42px;
		width: 100%;
		justify-content: center;
	}
</style>
