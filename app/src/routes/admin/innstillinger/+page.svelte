<script lang="ts">
	import { enhance } from '$app/forms';
	import { submit } from '$lib/submit';

	let { data, form } = $props();
	let enabled = $state(false);
	let text = $state('');
	let position = $state<'corner' | 'center'>('corner');
	$effect(() => {
		enabled = data.watermark.enabled;
		text = data.watermark.text;
		position = data.watermark.position;
	});
	let remind = $state(false);
	let days = $state(3);
	$effect(() => {
		remind = data.reminders.enabled;
		days = data.reminders.days;
	});
	const year = new Date().getFullYear();
</script>

<svelte:head><title>Innstillinger – Administrer</title></svelte:head>

<h1>Innstillinger</h1>

<div class="cols">
	<div class="stack">
	<form method="POST" action="?/watermark" use:enhance={submit()} class="panel">
		<h2>Vannmerke</h2>
		<p class="hint">
			Legges på bildene i offentlige album. Gjester som ser private album du har delt med dem, og du selv, ser bildene uten. Små
			miniatyrbilder og originalene du laster ned får aldri vannmerke.
		</p>
		<label class="check">
			<input type="checkbox" name="enabled" bind:checked={enabled} />
			Vis vannmerke på offentlige bilder
		</label>
		<label class="field">
			<span>Tekst</span>
			<input class="input" name="text" bind:value={text} maxlength="60" placeholder="© {year} Ditt navn" required={enabled} />
		</label>
		<fieldset class="field">
			<legend>Plassering</legend>
			<label class="check"><input type="radio" name="position" value="corner" bind:group={position} /> Lite, nede til høyre</label>
			<label class="check"><input type="radio" name="position" value="center" bind:group={position} /> Stort og svakt, midt på</label>
		</fieldset>
		<button class="btn primary" type="submit">Lagre</button>
	</form>

	<form method="POST" action="?/reminders" use:enhance={submit()} class="panel">
		<h2>Påminnelse før tilgangen går ut</h2>
		<p class="hint">
			Har en gruppe «tilgang til og med» en dato, får gjestene en e-post med en lenke som logger dem rett inn, noen dager før tilgangen går ut. De får én
			påminnelse per dato – endrer du datoen, kommer en ny.
		</p>
		{#if !data.mailReady}<p class="notice warn">E-post er ikke satt opp på serveren, så det sendes ingen påminnelser.</p>{/if}
		<label class="check">
			<input type="checkbox" name="enabled" bind:checked={remind} />
			Send påminnelse på e-post
		</label>
		<label class="field days">
			<span>Antall dager før</span>
			<input class="input" type="number" name="days" min="1" max="30" bind:value={days} required />
		</label>
		<button class="btn primary" type="submit">Lagre</button>
	</form>
	</div>

	{#if data.preview}
		<figure class="preview">
			<img
				src={data.preview.marked ?? data.preview.plain}
				alt="Eksempel på vannmerket"
				width={data.preview.w}
				height={data.preview.h}
			/>
			<figcaption class="faint">
				{data.preview.marked ? 'Slik ser besøkende det nyeste offentlige bildet.' : 'Vannmerket vises her når det er slått på og lagret.'}
			</figcaption>
		</figure>
	{/if}
</div>

<style>
	h1 {
		font-size: 28px;
		margin-bottom: 20px;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 440px) minmax(0, 1fr);
		gap: 32px;
		align-items: start;
	}
	@media (max-width: 900px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.stack {
		display: grid;
		gap: 20px;
	}
	.days .input {
		width: 110px;
	}
	.panel {
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
	.hint {
		color: var(--muted);
		font-size: 14px;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 8px;
	}
	legend {
		margin-bottom: 6px;
	}
	.preview {
		margin: 0;
		display: grid;
		gap: 8px;
	}
	.preview img {
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: 70vh;
		justify-self: start;
		border-radius: 8px;
		background: var(--surface-2);
	}
	figcaption {
		font-size: 13px;
	}
</style>
