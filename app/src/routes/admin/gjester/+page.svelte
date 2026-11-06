<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { formatDate, formatLocal } from '$lib/format';
	import { submit } from '$lib/submit';

	let { data, form } = $props();
	let copied = $state(false);
	let confirmDelete = $state<string | null>(null);
	let open = $state<Record<string, boolean>>({});

	$effect(() => {
		if (form && 'openGroup' in form && form.openGroup) open[form.openGroup] = true;
	});
	// Lenker som /admin/gjester#gruppe-<id> åpner gruppa.
	onMount(() => {
		const m = /^#gruppe-(.+)$/.exec(location.hash);
		if (m) {
			open[m[1]] = true;
			requestAnimationFrame(() => document.getElementById(`gruppe-${m[1]}`)?.scrollIntoView({ block: 'start' }));
		}
	});

	async function copy(text: string, input: HTMLInputElement | undefined) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			input?.select();
		}
	}
	let linkInput = $state<HTMLInputElement>();

	const KIND = { family: 'Familie og venner', client: 'Kunde' } as const;
	const DOWNLOAD = { album: 'Som albumet er satt opp', yes: 'Ja, alltid', no: 'Nei, bare se' } as const;
	// Datoen i feltet (ÅÅÅÅ-MM-DD) som «12. desember 2026».
	const dateText = (d: string) => (d ? formatDate(Date.parse(`${d}T12:00:00Z`)) : '');
</script>

<svelte:head><title>Gjester – Administrer</title></svelte:head>

<div class="cols">
	<section class="main">
		<h1>Gjester</h1>
		<p class="muted lead">
			Del private mapper og album med familie, venner og kunder. Lag en gruppe, legg til personer og velg hva gruppa skal se.
			Gjestene logger inn med en lenke på e-post og trenger aldri passord.
		</p>

		{#if !data.mailReady}
			<p class="notice warn">E-post er ikke satt opp på serveren ennå. Bruk «Kopier lenke» og send lenken selv.</p>
		{/if}
		{#if form && 'link' in form && form.link}
			<div class="notice success link">
				<strong>Lenke for {form.link.email}</strong>
				<p>Virker i 14 dager og kan brukes én gang. Send den på SMS eller e-post.</p>
				<div class="copyrow">
					<input bind:this={linkInput} id="copied-link" class="input" readonly value={form.link.url} onfocus={(e) => e.currentTarget.select()} />
					<button class="btn" type="button" onclick={() => copy(form.link!.url, linkInput)}>
						<Icon name={copied ? 'check' : 'link'} />
						{copied ? 'Kopiert' : 'Kopier'}
					</button>
				</div>
			</div>
		{/if}

		{#if data.groups.length === 0}
			<div class="empty">
				<Icon name="users" size={28} />
				<p>Ingen grupper ennå. Lag den første til høyre, for eksempel «Familien» eller navnet på en kunde.</p>
			</div>
		{/if}

		<div class="groups">
			{#each data.groups as g (g.id)}
				<details
					class="group"
					id="gruppe-{g.id}"
					open={open[g.id] ?? data.groups.length === 1}
					ontoggle={(e) => (open[g.id] = e.currentTarget.open)}
				>
					<summary>
						<span class="gname">{g.name}</span>
						<span class="badge">{KIND[g.kind]}</span>
						{#if g.expired}
							<span class="badge expired"><Icon name="clock" size={12} /> Utløpt</span>
						{:else if g.expiresDate}
							<span class="badge"><Icon name="clock" size={12} /> Til og med {dateText(g.expiresDate)}</span>
							{#if g.reminded_at}<span class="badge" title="Sendt {formatLocal(g.reminded_at)}"><Icon name="mail" size={12} /> Påminnelse sendt</span>{/if}
						{/if}
						<span class="faint count">{g.members.length} {g.members.length === 1 ? 'person' : 'personer'} · {g.access.length} delt</span>
					</summary>

					<div class="body">
						<div class="block">
							<h3>Personer</h3>
							{#if g.members.length}
								<ul class="rows">
									{#each g.members as m (m.id)}
										<li>
											<div class="who">
												<strong>{m.name || m.email}</strong>
												<span class="faint">{m.name ? `${m.email} · ` : ''}sist innlogget {formatLocal(m.last_login_at)}</span>
											</div>
											<div class="acts">
												{#if data.mailReady}
													<form method="POST" action="?/invite" use:enhance={submit()}>
														<input type="hidden" name="user" value={m.id} />
														<button class="btn ghost" type="submit" title="Send ny lenke på e-post"><Icon name="mail" size={16} /> Send lenke</button>
													</form>
												{/if}
												<form method="POST" action="?/copyLink" use:enhance={submit()}>
													<input type="hidden" name="user" value={m.id} />
													<button class="btn ghost" type="submit"><Icon name="link" size={16} /> Kopier lenke</button>
												</form>
												<form method="POST" action="?/removeMember" use:enhance={submit()}>
													<input type="hidden" name="group" value={g.id} />
													<input type="hidden" name="user" value={m.id} />
													<button class="btn ghost" type="submit" title="Fjern fra gruppa"><Icon name="x" size={16} /> Fjern</button>
												</form>
											</div>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="faint">Ingen ennå.</p>
							{/if}
							<form method="POST" action="?/addMember" use:enhance={submit({ reset: true })} class="add">
								<input type="hidden" name="group" value={g.id} />
								<label class="field">
									<span>Navn</span>
									<input id="name-{g.id}" class="input" name="name" maxlength="100" placeholder="Kari" />
								</label>
								<label class="field grow">
									<span>E-post</span>
									<input id="email-{g.id}" class="input" type="email" name="email" required maxlength="200" placeholder="kari@example.com" />
								</label>
								{#if data.mailReady}
									<label class="check">
										<input id="invite-{g.id}" type="checkbox" name="invite" checked />
										Send invitasjon
									</label>
								{/if}
								<button class="btn primary" type="submit"><Icon name="plus" size={16} /> Legg til</button>
							</form>
						</div>

						<div class="block">
							<h3>Har tilgang til</h3>
							{#if g.access.length}
								<ul class="rows">
									{#each g.access as a (a.id)}
										<li>
											<div class="who">
												<a href="/admin/node/{a.id}"><Icon name={a.type === 'album' ? 'image' : 'folder'} size={15} /> {a.name}</a>
												<span class="faint">{a.path}{a.type === 'folder' ? ' · med alt innhold' : ''}</span>
											</div>
											<div class="acts">
												<form method="POST" action="?/revoke" use:enhance={submit()}>
													<input type="hidden" name="group" value={g.id} />
													<input type="hidden" name="node" value={a.id} />
													<button class="btn ghost" type="submit"><Icon name="x" size={16} /> Fjern</button>
												</form>
											</div>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="faint">Ingenting delt ennå.</p>
							{/if}
							<form method="POST" action="?/grant" use:enhance={submit()} class="add">
								<input type="hidden" name="group" value={g.id} />
								<label class="field grow">
									<span>Mappe eller album</span>
									<select id="node-{g.id}" class="input" name="node" required>
										<option value="">Velg …</option>
										{#each data.nodes as n (n.id)}
											{#if !g.access.some((a) => a.id === n.id)}
												<option value={n.id}>{n.type === 'folder' ? '▸ ' : ''}{n.label}</option>
											{/if}
										{/each}
									</select>
								</label>
								<button class="btn primary" type="submit"><Icon name="plus" size={16} /> Gi tilgang</button>
							</form>
						</div>

						<div class="block settings">
							<form method="POST" action="?/updateGroup" use:enhance={submit()} class="add">
								<input type="hidden" name="group" value={g.id} />
								<label class="field grow">
									<span>Gruppenavn</span>
									<input id="gname-{g.id}" class="input" name="name" value={g.name} required maxlength="100" />
								</label>
								<label class="field">
									<span>Type</span>
									<select id="gkind-{g.id}" class="input" name="kind" value={g.kind}>
										<option value="family">Familie og venner</option>
										<option value="client">Kunde</option>
									</select>
								</label>
								<label class="field">
									<span>Kan laste ned originaler</span>
									<select id="gdl-{g.id}" class="input" name="download" value={g.download}>
										{#each Object.entries(DOWNLOAD) as [value, label] (value)}
											<option {value}>{label}</option>
										{/each}
									</select>
								</label>
								<label class="field">
									<span>Tilgang til og med</span>
									<input id="gexp-{g.id}" class="input" type="date" name="expires" value={g.expiresDate} />
								</label>
								<button class="btn" type="submit">Lagre</button>
							</form>
							<p class="faint hint">
								La datoen stå tom for tilgang uten slutt. Etter datoen ser gruppa ikke lenger det som er delt, men alt blir liggende,
								så du kan forlenge senere.
							</p>
							{#if confirmDelete === g.id}
								<form method="POST" action="?/deleteGroup" use:enhance={submit()} class="buttons">
									<input type="hidden" name="group" value={g.id} />
									<span class="faint">Personer som bare er med i denne gruppa, mister tilgangen.</span>
									<button class="btn danger solid" type="submit">Ja, slett gruppa</button>
									<button class="btn ghost" type="button" onclick={() => (confirmDelete = null)}>Avbryt</button>
								</form>
							{:else}
								<button class="btn danger" type="button" onclick={() => (confirmDelete = g.id)}><Icon name="trash" size={16} /> Slett gruppa</button>
							{/if}
						</div>
					</div>
				</details>
			{/each}
		</div>
	</section>

	<aside class="side">
		<form method="POST" action="?/createGroup" use:enhance={submit({ reset: true })} class="panel">
			<h2>Ny gruppe</h2>
			<label class="field">
				<span>Navn</span>
				<input id="new-group-name" class="input" name="name" required maxlength="100" placeholder="Familien, eller navnet på kunden" />
			</label>
			<label class="field">
				<span>Type</span>
				<select id="new-group-kind" class="input" name="kind">
					<option value="family">Familie og venner</option>
					<option value="client">Kunde</option>
				</select>
			</label>
			<button class="btn primary" type="submit"><Icon name="plus" size={16} /> Lag gruppe</button>
		</form>

		<div class="panel howto">
			<h2>Slik virker det</h2>
			<ul>
				<li>Gjester ser alt som er offentlig, og i tillegg det som er delt med gruppene deres. Det står under «Delt med deg» på forsiden.</li>
				<li>Deler du en mappe, får de alt som ligger i den, også album du legger til senere.</li>
				<li>Innloggingen varer i 30 dager. Etterpå ber de om en ny lenke på innloggingssiden.</li>
				<li>
					Raskest er ofte albumsiden under Bibliotek: velg <strong>Privat</strong> og klikk på en gruppe, eller <strong>Kunde</strong> og skriv inn
					navn og e-post – da lages kunden og invitasjonen sendes med en gang.
				</li>
				<li>Kunder kan trykke på hjertet på bildene de liker og sende valget til deg. Du får en e-post, og valget står på albumsiden.</li>
				<li>Nye kundegrupper kan ikke laste ned før du endrer det, for eksempel når de har betalt.</li>
			</ul>
		</div>
	</aside>
</div>

<style>
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 32px;
		align-items: start;
	}
	@media (max-width: 960px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.main {
		display: grid;
		gap: 16px;
		min-width: 0;
	}
	h1 {
		font-size: 28px;
	}
	.lead {
		max-width: 62ch;
	}
	.link {
		display: grid;
		gap: 8px;
	}
	.copyrow {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.copyrow .input {
		flex: 1;
		min-width: 0;
		font-size: 13px;
	}
	.empty {
		display: grid;
		justify-items: start;
		gap: 10px;
		padding: 28px;
		border: 1px dashed var(--line);
		border-radius: 12px;
		color: var(--muted);
	}
	.groups {
		display: grid;
		gap: 12px;
	}
	.group {
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		padding: 16px 18px;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::before {
		content: '▸';
		color: var(--muted);
		transition: transform 0.15s;
	}
	.group[open] summary::before {
		transform: rotate(90deg);
	}
	.gname {
		font-weight: 600;
		font-size: 17px;
	}
	.count {
		margin-left: auto;
		font-size: 13px;
	}
	.body {
		display: grid;
		gap: 22px;
		padding: 4px 18px 20px;
	}
	.block {
		display: grid;
		gap: 10px;
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}
	.rows li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 12px;
	}
	.rows li + li {
		border-top: 1px solid var(--line);
	}
	.who {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.who a {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
	}
	.who a:hover {
		text-decoration: underline;
	}
	.who .faint {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.acts form {
		margin: 0;
	}
	.acts .btn {
		font-size: 13px;
		padding: 6px 10px;
	}
	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
	}
	.add .field {
		min-width: 140px;
	}
	.add .grow {
		flex: 1;
		min-width: 200px;
	}
	.add .check {
		padding-bottom: 10px;
	}
	.settings {
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}
	.hint {
		font-size: 13px;
		max-width: 70ch;
	}
	.badge.expired {
		color: var(--danger, #e5484d);
	}
	.settings > .btn {
		justify-self: start;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.side {
		display: grid;
		gap: 16px;
	}
	.panel {
		display: grid;
		gap: 14px;
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.panel h2 {
		font-size: 17px;
	}
	.howto ul {
		margin: 0;
		padding-left: 18px;
		display: grid;
		gap: 8px;
		color: var(--muted);
		font-size: 14px;
	}
</style>
