<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let enabled = $state(false);
	let text = $state('');
	let position = $state<'corner' | 'center'>('corner');
	$effect(() => {
		enabled = data.watermark.enabled;
		text = data.watermark.text;
		position = data.watermark.position;
	});
	const year = new Date().getFullYear();
</script>

<svelte:head><title>Innstillinger – Administrer</title></svelte:head>

<h1>Innstillinger</h1>

<div class="cols">
	<form method="POST" action="?/watermark" use:enhance={() => async ({ update }) => update({ reset: false })} class="panel">
		<h2>Vannmerke</h2>
		<p class="hint">
			Legges på bildene i offentlige album. Gjester som ser private album du har delt med dem, og du selv, ser bildene uten. Små
			miniatyrbilder og originalene du laster ned får aldri vannmerke.
		</p>
		{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}
		{#if form?.saved}<p class="notice success" role="status">Lagret.</p>{/if}
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
