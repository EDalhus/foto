<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { formatLocal } from '$lib/format';

	let { data, form } = $props();
	let copied = $state(false);

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<svelte:head><title>Lightroom og API – Administrer</title></svelte:head>

<div class="cols">
	<section>
		<h1>Lightroom og API-nøkler</h1>
		<p class="muted lead">
			Lightroom kobler seg til selv når du trykker «Koble til Foto …», og nøkkelen dukker opp i lista under. Trekk den tilbake
			hvis maskinen blir borte. Egne nøkler trenger du bare til andre programmer og skript.
		</p>

		{#if form?.error}<p class="notice error">{form.error}</p>{/if}

		{#if form?.created}
			<div class="notice success created">
				<strong>Nøkkelen «{form.created.name}» er laget.</strong>
				<p>Kopier den nå – den vises bare denne ene gangen.</p>
				<div class="token">
					<code>{form.created.token}</code>
					<button class="btn" onclick={() => copy(form.created!.token)}>
						<Icon name={copied ? 'check' : 'link'} />
						{copied ? 'Kopiert' : 'Kopier'}
					</button>
				</div>
			</div>
		{/if}

		<form method="POST" action="?/create" use:enhance class="new">
			<label class="field">
				<span>Navn på ny nøkkel</span>
				<input class="input" name="name" placeholder="Skript for sikkerhetskopi" maxlength="80" />
			</label>
			<button class="btn primary" type="submit"><Icon name="key" /> Lag nøkkel</button>
		</form>

		{#if data.tokens.length}
			<ul class="list">
				{#each data.tokens as t (t.id)}
					<li>
						<div>
							<strong>{t.name}</strong>
							<span class="faint"><code>{t.prefix}…</code> · laget {formatLocal(t.created_at)} · sist brukt {formatLocal(t.last_used_at)}</span>
						</div>
						<form method="POST" action="?/delete" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button class="btn danger" type="submit">Trekk tilbake</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<aside class="howto">
		<h2>Slik kobler du til Lightroom Classic</h2>
		<ol>
			<li>Åpne <strong>Fil → Behandle tilleggsprogrammer</strong> og sjekk at «Foto» er lagt til og aktivert.</li>
			<li>I panelet <strong>Publiser tjenester</strong> til venstre: klikk <strong>+</strong> → <strong>Gå til Administrasjon av publisering</strong> og velg «Foto».</li>
			<li>Sjekk at serveradressen er <code>{data.serverUrl}</code> og trykk <strong>Koble til Foto …</strong>. Nettleseren åpner seg: logg inn, sjekk at koden er den samme som i Lightroom, og trykk <strong>Koble til</strong>. Gå tilbake til Lightroom og trykk <strong>Lagre</strong>.</li>
			<li>Lag mapper og album under Foto (høyreklikk), dra bilder inn og trykk <strong>Publiser</strong>.</li>
			<li>Har du allerede album i SmugMug-tjenesten? <strong>Fil → Ekstra pluginmoduler → Kopier album fra SmugMug</strong> lager samme struktur under Foto. Ingenting lastes opp før du trykker Publiser.</li>
		</ol>
	</aside>
</div>

<style>
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		gap: 32px;
		align-items: start;
	}
	@media (max-width: 960px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	h1 {
		font-size: 28px;
	}
	.lead {
		margin: 8px 0 20px;
		max-width: 60ch;
	}
	.notice {
		margin-bottom: 18px;
	}
	.created {
		display: grid;
		gap: 8px;
	}
	.token {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
	}
	.token code {
		flex: 1;
		min-width: 0;
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
		word-break: break-all;
		font-size: 13px;
	}
	.new {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
		margin-bottom: 24px;
	}
	.new .field {
		flex: 1;
		min-width: 220px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		background: var(--surface);
	}
	.list li + li {
		border-top: 1px solid var(--line);
	}
	.list div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.list span {
		font-size: 13px;
	}
	.howto {
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.howto h2 {
		font-size: 17px;
		margin-bottom: 12px;
	}
	.howto ol {
		margin: 0;
		padding-left: 20px;
		display: grid;
		gap: 10px;
		font-size: 14px;
		color: var(--muted);
	}
	.howto strong {
		color: var(--text);
		font-weight: 500;
	}
	code {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.92em;
	}
</style>
