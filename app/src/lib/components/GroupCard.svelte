<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { formatLocal } from '$lib/format';
	import { submit } from '$lib/submit';
	import { toast } from '$lib/toasts.svelte';
	import type { GroupAccessView } from '$lib/types';
	import Icon from './Icon.svelte';

	/** En gruppe (eller kunde) som har tilgang: personene, lenkene deres og – for kunder – nedlasting og utløpsdato. */
	let {
		g,
		client = false,
		albumDownload = false,
		isAlbum = true,
		mailReady = false
	}: { g: GroupAccessView; client?: boolean; albumDownload?: boolean; isAlbum?: boolean; mailReady?: boolean } = $props();

	let adding = $state(false);
	let manual = $state<{ user: string; url: string } | null>(null);
	const canDownload = $derived(g.download === 'yes' || (g.download === 'album' && albumDownload));

	async function fetchLink(user: string): Promise<string> {
		const body = new FormData();
		body.set('user', user);
		const res = await fetch('?/copyLink', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
		const r = deserialize(await res.text());
		if (r.type === 'success' && typeof r.data?.link === 'string') return r.data.link;
		throw new Error(r.type === 'failure' ? String(r.data?.error ?? '') : 'Klarte ikke å lage lenken.');
	}

	// Safari krever at utklippstavla skrives mens trykket «gjelder», derfor ClipboardItem med et løfte.
	async function copyLink(user: string) {
		manual = null;
		let link = '';
		const linkPromise = fetchLink(user).then((l) => (link = l));
		try {
			if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
				await navigator.clipboard.write([new ClipboardItem({ 'text/plain': linkPromise.then((l) => new Blob([l], { type: 'text/plain' })) })]);
			} else {
				await navigator.clipboard.writeText(await linkPromise);
			}
			toast('Lenken er kopiert. Den virker i 14 dager og kan brukes én gang.');
		} catch (err) {
			try {
				await linkPromise;
			} catch {
				toast((err as Error).message || 'Klarte ikke å lage lenken.', 'error');
				return;
			}
			if (link) manual = { user, url: link };
		}
	}

	const autosubmit = (e: Event) => (e.currentTarget as HTMLInputElement).form?.requestSubmit();
</script>

<article class="card" class:expired={g.expired}>
	<header>
		<div class="title">
			<Icon name={g.kind === 'client' ? 'user' : 'users'} size={16} />
			<a class="gname" href="/admin/gjester#gruppe-{g.id}" title="Åpne gruppa under Gjester">{g.name}</a>
			{#if g.expired}<span class="badge bad"><Icon name="clock" size={12} /> Utløpt</span>{/if}
		</div>
		{#if g.direct}
			<form method="POST" action="?/toggleGroup" use:enhance={submit()}>
				<input type="hidden" name="group" value={g.id} />
				<input type="hidden" name="on" value="0" />
				<button class="btn ghost small" type="submit" title="Fjern tilgangen for {g.name}"><Icon name="x" size={14} /> Fjern</button>
			</form>
		{:else if g.via}
			<span class="faint small">via «{g.via}»</span>
		{/if}
	</header>

	{#if g.members.length}
		<ul class="people">
			{#each g.members as m (m.id)}
				<li>
					<div class="who">
						<span class="name">{m.name || m.email}</span>
						<span class="faint">
							{m.name ? `${m.email} · ` : ''}{m.lastLogin ? `sist innlogget ${formatLocal(m.lastLogin)}` : 'ikke logget inn ennå'}
						</span>
					</div>
					<div class="acts">
						<button class="btn ghost small" type="button" onclick={() => copyLink(m.id)} title="Kopier innloggingslenke">
							<Icon name="copy" size={14} /> Kopier lenke
						</button>
						{#if mailReady}
							<form method="POST" action="?/sendLink" use:enhance={submit()}>
								<input type="hidden" name="user" value={m.id} />
								<button class="btn ghost small" type="submit" title="Send ny lenke på e-post"><Icon name="mail" size={14} /> Send</button>
							</form>
						{/if}
						<form method="POST" action="?/removePerson" use:enhance={submit()}>
							<input type="hidden" name="group" value={g.id} />
							<input type="hidden" name="user" value={m.id} />
							<button class="btn ghost small icon-only" type="submit" title="Fjern {m.name || m.email} fra gruppa" aria-label="Fjern {m.name || m.email}">
								<Icon name="trash" size={14} />
							</button>
						</form>
					</div>
					{#if manual?.user === m.id}
						<div class="manual">
							<span class="faint">Kopier lenken:</span>
							<input class="input" readonly value={manual.url} onfocus={(e) => e.currentTarget.select()} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="faint small">Ingen personer ennå – legg til den som skal se {isAlbum ? 'albumet' : 'mappa'}.</p>
	{/if}

	{#if adding}
		<form method="POST" action="?/addPerson" class="add" use:enhance={submit({ reset: true, onsuccess: () => (adding = false) })}>
			<input type="hidden" name="group" value={g.id} />
			<input class="input" name="name" placeholder="Navn" maxlength="100" aria-label="Navn" />
			<input class="input" type="email" name="email" placeholder="E-post" required maxlength="200" aria-label="E-post" />
			{#if mailReady}<label class="check small"><input type="checkbox" name="invite" checked /> Send invitasjon</label>{/if}
			<div class="row">
				<button class="btn primary small" type="submit"><Icon name="plus" size={14} /> Legg til</button>
				<button class="btn ghost small" type="button" onclick={() => (adding = false)}>Avbryt</button>
			</div>
		</form>
	{:else}
		<button class="btn ghost small add-btn" type="button" onclick={() => (adding = true)}><Icon name="plus" size={14} /> Legg til person</button>
	{/if}

	{#if client}
		<div class="opts">
			<form method="POST" action="?/groupDownload" use:enhance={submit()}>
				<input type="hidden" name="group" value={g.id} />
				<input type="hidden" name="on" value={canDownload ? '0' : '1'} />
				<label class="check">
					<input type="checkbox" checked={canDownload} onchange={autosubmit} />
					Kan laste ned originalene
				</label>
			</form>
			<form method="POST" action="?/groupExpiry" use:enhance={submit()} class="expiry">
				<input type="hidden" name="group" value={g.id} />
				<label for="exp-{g.id}">Tilgang til og med</label>
				<input id="exp-{g.id}" class="input small" type="date" name="expires" value={g.expiresDate} onchange={autosubmit} />
			</form>
			<p class="faint small">Gjelder alt som er delt med {g.name}.</p>
		</div>
	{/if}
</article>

<style>
	.card {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--bg);
	}
	.card.expired {
		border-color: rgba(255, 107, 94, 0.35);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 30px;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.gname {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gname:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.title :global(svg) {
		flex: none;
		color: var(--muted);
	}
	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.people li {
		display: grid;
		gap: 4px;
	}
	.who {
		display: grid;
		min-width: 0;
	}
	.name {
		font-size: 14px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.who .faint {
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		margin-left: -8px;
	}
	.acts form {
		margin: 0;
	}
	.manual {
		display: grid;
		gap: 4px;
		font-size: 12px;
	}
	.manual .input {
		font-size: 12px;
		min-height: 32px;
	}
	.small {
		font-size: 12.5px;
	}
	.btn.small {
		min-height: 30px;
		padding: 0 9px;
		font-size: 12.5px;
	}
	.btn.small :global(svg) {
		width: 14px;
		height: 14px;
	}
	.icon-only {
		color: var(--faint);
	}
	.icon-only:hover {
		color: var(--danger);
	}
	.add {
		display: grid;
		gap: 6px;
	}
	.add .input {
		min-height: 36px;
		font-size: 14px;
	}
	.row {
		display: flex;
		gap: 6px;
	}
	.add-btn {
		justify-self: start;
		margin-left: -8px;
	}
	.opts {
		display: grid;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}
	.opts form {
		margin: 0;
	}
	.opts .check {
		font-size: 14px;
	}
	.expiry {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 14px;
	}
	.input.small {
		width: auto;
		min-height: 34px;
		padding: 4px 8px;
		font-size: 13px;
	}
</style>
