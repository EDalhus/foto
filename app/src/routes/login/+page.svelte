<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { form } = $props();
	let busy = $state(false);
	let mode = $state<'link' | 'password'>(page.url.searchParams.get('passord') !== null ? 'password' : 'link');
	$effect(() => {
		if (form?.mode === 'password' || form?.mode === 'link') mode = form.mode;
	});
	const submit = () => {
		busy = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = false;
		};
	};
	const next = $derived(page.url.searchParams.get('next'));
	const action = (name: string) => `?/${name}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
</script>

<svelte:head>
	<title>Logg inn</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap">
	{#if form?.sent}
		<div class="card">
			<h1>Sjekk e-posten din</h1>
			<p>
				Hvis <strong>{form.sent}</strong> har tilgang, har vi sendt en lenke dit. Den virker i 30 minutter.
			</p>
			<p class="muted">Finner du den ikke? Se i søppelpost-mappa, eller spør den som delte bildene med deg.</p>
			<a class="btn" href="/login">Prøv en annen adresse</a>
		</div>
	{:else if mode === 'link'}
		<form method="POST" action={action('link')} class="card" use:enhance={submit}>
			<h1>Logg inn</h1>
			<p class="muted">Har du fått tilgang til private album? Skriv e-postadressen din, så sender vi deg en lenke.</p>
			{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
			<label class="field">
				<span>E-post</span>
				<input id="email-link" class="input" type="email" name="email" autocomplete="email" required value={form?.email ?? ''} />
			</label>
			<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Sender …' : 'Send meg en lenke'}</button>
			<button class="switch" type="button" onclick={() => (mode = 'password')}>Administrator? Logg inn med passord</button>
		</form>
	{:else}
		<form method="POST" action={action('password')} class="card" use:enhance={submit}>
			<h1>Logg inn</h1>
			{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
			<label class="field">
				<span>E-post</span>
				<input id="email-password" class="input" type="email" name="email" autocomplete="username" required value={form?.email ?? ''} />
			</label>
			<label class="field">
				<span>Passord</span>
				<input id="password" class="input" type="password" name="password" autocomplete="current-password" required />
			</label>
			<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Logger inn …' : 'Logg inn'}</button>
			<button class="switch" type="button" onclick={() => (mode = 'link')}>Gjest? Få en lenke på e-post</button>
		</form>
	{/if}
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
		margin-top: 4px;
		min-height: 42px;
		justify-content: center;
	}
	.switch {
		background: none;
		border: 0;
		padding: 0;
		color: var(--muted);
		font: inherit;
		font-size: 14px;
		cursor: pointer;
		justify-self: center;
	}
	.switch:hover {
		color: var(--text);
		text-decoration: underline;
	}
</style>
