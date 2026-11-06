<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { plural } from '$lib/format';
	import { submit } from '$lib/submit';
	import type { AccessMode, GroupAccessView } from '$lib/types';
	import GroupCard from './GroupCard.svelte';
	import Icon from './Icon.svelte';

	/**
	 * Hvem ser albumet/mappa? Velgeren Offentlig / Privat / Kunde, og under den gruppene og kundene.
	 * Alt lagres med en gang. Å gjøre noe offentlig, eller ta tilgangen fra en kunde, må bekreftes.
	 */
	let {
		node,
		access,
		mailReady,
		activity = {}
	}: {
		node: { id: string; type: 'folder' | 'album'; allowDownload: boolean };
		access: { mode: AccessMode; privateVia: string | null; groups: GroupAccessView[] };
		mailReady: boolean;
		/** Hva hver gjest har sett og lastet ned her (bruker-id → tall). */
		activity?: Record<string, { views: number; downloads: number; zips: number; lastAt: number }>;
	} = $props();

	const isAlbum = $derived(node.type === 'album');
	const it = $derived(isAlbum ? 'albumet' : 'mappa');
	const It = $derived(isAlbum ? 'Albumet' : 'Mappa');

	// Valg i velgeren som ikke er lagret ennå («Kunde» før en kunde er valgt, eller noe som må bekreftes).
	let picked = $state<AccessMode | null>(null);
	let confirming = $state<'public' | 'private' | null>(null);
	let newGroup = $state(false);
	const mode = $derived(access.mode);
	const shown = $derived(picked ?? mode);
	$effect(() => {
		void mode;
		untrack(() => {
			picked = null;
			confirming = null;
		});
	});

	const shared = $derived(access.groups.filter((g) => g.shared));
	const sharedClients = $derived(shared.filter((g) => g.kind === 'client'));
	const sharedFamily = $derived(shared.filter((g) => g.kind === 'family'));
	const otherClients = $derived(access.groups.filter((g) => g.kind === 'client' && !g.shared));
	const otherFamily = $derived(access.groups.filter((g) => g.kind === 'family' && !g.shared));
	const directClients = $derived(sharedClients.filter((g) => g.direct));

	function pick(m: AccessMode) {
		newGroup = false;
		if (m === mode) {
			picked = null;
			confirming = null;
			return;
		}
		picked = m;
		confirming = m === 'public' ? 'public' : m === 'private' && mode === 'client' ? 'private' : null;
	}

	const OPTIONS: { id: AccessMode; label: string; icon: string }[] = [
		{ id: 'public', label: 'Offentlig', icon: 'globe' },
		{ id: 'private', label: 'Privat', icon: 'lock' },
		{ id: 'client', label: 'Kunde', icon: 'user' }
	];
	const autosubmit = (e: Event) => (e.currentTarget as HTMLInputElement).form?.requestSubmit();
</script>

<section class="panel" id="tilgang" aria-labelledby="tilgang-h">
	<h2 id="tilgang-h">Hvem kan se {it}?</h2>

	<form method="POST" action="?/access" use:enhance={submit()}>
		<div class="seg" role="group" aria-label="Tilgang">
		{#each OPTIONS as o (o.id)}
			{@const disabled = o.id === 'public' && !!access.privateVia}
			{#if o.id === 'private' && mode === 'public'}
				<button type="submit" name="mode" value="private" aria-pressed={shown === o.id} class:on={shown === o.id}>
					<Icon name={o.icon} size={16} />
					{o.label}
				</button>
			{:else}
				<button
					type="button"
					aria-pressed={shown === o.id}
					class:on={shown === o.id}
					{disabled}
					title={disabled ? `Ligger i den private mappa «${access.privateVia}»` : undefined}
					onclick={() => pick(o.id)}
				>
					<Icon name={o.icon} size={16} />
					{o.label}
				</button>
			{/if}
		{/each}
		</div>
	</form>

	{#if access.privateVia}
		<p class="hint"><Icon name="lock" size={12} /> Ligger i den private mappa «{access.privateVia}», så {it} er privat uansett.</p>
	{/if}

	{#if confirming === 'public'}
		<form method="POST" action="?/access" use:enhance={submit()} class="confirm">
			<input type="hidden" name="mode" value="public" />
			<p>
				<strong>Gjøre {it} offentlig?</strong> Alle kan da se bildene, og {it} vises på forsiden og i søket.
				{#if shared.length}Gruppene som har tilgang nå, ser det fortsatt under «Delt med deg».{/if}
			</p>
			<div class="row">
				<button class="btn primary" type="submit"><Icon name="globe" size={16} /> Gjør offentlig</button>
				<button class="btn ghost" type="button" onclick={() => pick(mode)}>Avbryt</button>
			</div>
		</form>
	{:else if confirming === 'private'}
		<form method="POST" action="?/access" use:enhance={submit()} class="confirm">
			<input type="hidden" name="mode" value="private" />
			<input type="hidden" name="removeClients" value="1" />
			{#if directClients.length}
				<p>
					<strong>Ta tilgangen fra {directClients.map((g) => g.name).join(' og ')}?</strong>
					{It} blir et vanlig privat {isAlbum ? 'album' : 'mappe'} som bare du og gruppene du velger, ser.
				</p>
				<div class="row">
					<button class="btn danger solid" type="submit">Fjern kundetilgangen</button>
					<button class="btn ghost" type="button" onclick={() => pick(mode)}>Avbryt</button>
				</div>
			{:else}
				<p>Kundetilgangen kommer fra mappa over. Endre den der.</p>
				<div class="row"><button class="btn ghost" type="button" onclick={() => pick(mode)}>OK</button></div>
			{/if}
		</form>
	{/if}

	{#if shown === 'public'}
		<p class="hint">Alle kan se {it}. {isAlbum ? 'Det' : 'Den'} vises på forsiden og i søket.</p>
		{#if isAlbum}
			<form method="POST" action="?/allowDownload" use:enhance={submit()}>
				<input type="hidden" name="on" value={node.allowDownload ? '0' : '1'} />
				<label class="check"><input type="checkbox" checked={node.allowDownload} onchange={autosubmit} /> Alle kan laste ned originalene</label>
			</form>
		{/if}
		{#if shared.length}
			<p class="hint">Vises også under «Delt med deg» hos {shared.map((g) => g.name).join(', ')}.</p>
		{/if}
	{:else if shown === 'private'}
		<p class="hint">Bare du og gruppene du deler med, kan se {it}.</p>
		{#if shared.length}
			<div class="cards">
				{#each shared as g (g.id)}
					<GroupCard {g} client={g.kind === 'client'} albumDownload={node.allowDownload} {isAlbum} {mailReady} {activity} />
				{/each}
			</div>
		{/if}
		{#if otherFamily.length || otherClients.length}
			<p class="label">{shared.length ? 'Del med flere' : 'Del med'}</p>
		{/if}
		<div class="chips">
			{#each [...otherFamily, ...otherClients] as g (g.id)}
				<form method="POST" action="?/toggleGroup" use:enhance={submit()}>
					<input type="hidden" name="group" value={g.id} />
					<input type="hidden" name="on" value="1" />
					<button class="chip" type="submit" title="Del med {g.name}">
						<Icon name="plus" size={14} />
						{g.name}
						<span class="faint">{g.kind === 'client' ? 'kunde' : plural(g.members.length, 'person', 'personer')}</span>
					</button>
				</form>
			{/each}
			<button class="chip new" type="button" onclick={() => (newGroup = !newGroup)} aria-expanded={newGroup}>
				<Icon name="users" size={14} /> Ny gruppe
			</button>
		</div>
		{#if newGroup}
			<form method="POST" action="?/newGroup" class="inline-form" use:enhance={submit({ reset: true, onsuccess: () => (newGroup = false) })}>
				<label class="field">
					<span>Navn på gruppa</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input class="input" name="name" required maxlength="100" placeholder="Familien, Venner …" autofocus />
				</label>
				<div class="row">
					<button class="btn primary" type="submit"><Icon name="plus" size={16} /> Lag og del</button>
					<button class="btn ghost" type="button" onclick={() => (newGroup = false)}>Avbryt</button>
				</div>
			</form>
		{/if}
		{#if isAlbum}
			<form method="POST" action="?/allowDownload" use:enhance={submit()}>
				<input type="hidden" name="on" value={node.allowDownload ? '0' : '1'} />
				<label class="check"><input type="checkbox" checked={node.allowDownload} onchange={autosubmit} /> Gjestene kan laste ned originalene</label>
			</form>
		{/if}
	{:else}
		<p class="hint">
			Kunden logger inn med en lenke på e-post, ser {it}, kan hjerte bildene de vil ha og sende valget til deg.
			{#if mode === 'public'}{It} blir privat når du velger kunden.{/if}
		</p>
		{#if sharedClients.length}
			<div class="cards">
				{#each sharedClients as g (g.id)}
					<GroupCard {g} client albumDownload={node.allowDownload} {isAlbum} {mailReady} {activity} />
				{/each}
			</div>
		{/if}
		{#if otherClients.length}
			<p class="label">{sharedClients.length ? 'Lever også til' : 'Lever til en kunde du har fra før'}</p>
			<div class="chips">
				{#each otherClients as g (g.id)}
					<form method="POST" action="?/toggleGroup" use:enhance={submit()}>
						<input type="hidden" name="group" value={g.id} />
						<input type="hidden" name="on" value="1" />
						<input type="hidden" name="makePrivate" value="1" />
						<button class="chip" type="submit"><Icon name="user" size={14} /> {g.name}</button>
					</form>
				{/each}
			</div>
		{/if}
		<form method="POST" action="?/newClient" class="inline-form new-client" use:enhance={submit({ reset: true })}>
			<p class="label">{sharedClients.length || otherClients.length ? 'Ny kunde' : 'Hvem skal få bildene?'}</p>
			<label class="field">
				<span>Navn</span>
				<input class="input" name="name" required maxlength="100" placeholder="Kari og Ola Hansen" autocomplete="off" />
			</label>
			<label class="field">
				<span>E-post</span>
				<input class="input" type="email" name="email" required maxlength="200" placeholder="kari@example.com" autocomplete="off" />
			</label>
			{#if mailReady}
				<label class="check"><input type="checkbox" name="invite" checked /> Send invitasjon på e-post nå</label>
			{/if}
			<button class="btn primary" type="submit"><Icon name="send" size={16} /> Lever {it}</button>
		</form>
		{#if sharedFamily.length}
			<p class="hint">
				Også delt med {sharedFamily.map((g) => (g.via ? `${g.name} (via «${g.via}»)` : g.name)).join(', ')}. Se dem under «Privat».
			</p>
		{/if}
	{/if}
</section>

<style>
	.panel {
		display: grid;
		gap: 14px;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	h2 {
		font-size: 17px;
	}
	.seg {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
		padding: 4px;
		border-radius: 12px;
		background: var(--bg);
		border: 1px solid var(--line);
	}
	.seg button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 38px;
		padding: 0 6px;
		border: 0;
		border-radius: 9px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.seg button:hover:not(:disabled) {
		color: var(--text);
	}
	.seg button.on {
		background: var(--surface-3);
		color: var(--text);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
	}
	.seg button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.label {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--faint);
		margin-bottom: -6px;
	}
	.confirm {
		display: grid;
		gap: 10px;
		padding: 12px;
		border-radius: 10px;
		border: 1px solid #b8862b;
		background: rgba(242, 193, 78, 0.06);
		font-size: 14px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.cards {
		display: grid;
		gap: 10px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chips form {
		margin: 0;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 11px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.chip:hover {
		background: var(--surface-3);
	}
	.chip .faint {
		font-size: 12px;
	}
	.chip.new {
		border-style: dashed;
		background: none;
		color: var(--muted);
	}
	.chip.new:hover {
		color: var(--text);
	}
	.inline-form {
		display: grid;
		gap: 10px;
	}
	.new-client {
		padding-top: 4px;
	}
	.check {
		font-size: 14px;
	}
</style>
