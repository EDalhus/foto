<script lang="ts">
	import { enhance } from '$app/forms';
	import { submit } from '$lib/submit';
	import Icon from './Icon.svelte';

	/**
	 * Kategoriene i en mappe (eller på forsiden) i admin: lag, gi nytt navn og farge, flytt, slett –
	 * og velg hvordan kundene ser dem. Skjemaene går til handlingene i categoryActions på samme side.
	 */
	interface Category {
		id: string;
		name: string;
		description: string;
		color: string | null;
		hex: string | null;
		count: number;
	}
	let {
		categories,
		style,
		colors,
		previewHref,
		where = 'mappa'
	}: {
		categories: Category[];
		style: string | null;
		colors: { id: string; name: string; hex: string }[];
		/** Lenke til siden slik kundene ser den. */
		previewHref: string;
		/** «mappa» eller «forsiden» i hjelpeteksten. */
		where?: string;
	} = $props();

	const STYLES = [
		{ id: 'sections', name: 'Overskrifter', desc: 'En overskrift over hver kategori.' },
		{ id: 'tags', name: 'Merkelapp', desc: 'Kategorien står på hvert kort.' },
		{ id: 'filter', name: 'Filterknapper', desc: 'Kunden ser én kategori om gangen.' },
		{ id: 'boxes', name: 'Bokser', desc: 'Hver kategori i sin egen ramme.' },
		{ id: 'rows', name: 'Rader', desc: 'Én rad per kategori, blas sideveis.' },
		{ id: 'stacks', name: 'Bunker', desc: 'Hver kategori er en bunke man åpner.' },
		{ id: 'none', name: 'Av', desc: 'Vanlig rutenett uten kategorier.' }
	] as const;

	let editing = $state<string | null>(null);
	let confirmDelete = $state<string | null>(null);
	let newName = $state('');
</script>

<section class="panel" id="kategorier">
	<div class="panel-head">
		<h2>Kategorier</h2>
		{#if categories.length}<a class="linkish" href={previewHref} target="_blank" rel="noopener">Se som kunde</a>{/if}
	</div>
	<p class="hint">
		Del innholdet i {where} inn i grupper, for eksempel båtene etter rederi. Kundene ser dem samlet, slik du velger under.
	</p>

	{#if categories.length}
		<ul class="cats">
			{#each categories as c, i (c.id)}
				<li class:open={editing === c.id}>
					<div class="cat">
						<span class="cdot" class:none={!c.hex} style:background={c.hex ?? undefined}></span>
						<span class="cname">{c.name}</span>
						<span class="ccount" title="Album og mapper i kategorien">{c.count}</span>
						<form method="POST" action="?/categoryMove" use:enhance={submit()} class="mini-form">
							<input type="hidden" name="id" value={c.id} />
							<button class="mini" name="dir" value="up" disabled={i === 0} aria-label="Flytt «{c.name}» opp" title="Flytt opp"
								><Icon name="up" size={15} /></button
							>
							<button
								class="mini"
								name="dir"
								value="down"
								disabled={i === categories.length - 1}
								aria-label="Flytt «{c.name}» ned"
								title="Flytt ned"><Icon name="down" size={15} /></button
							>
						</form>
						<button
							class="mini"
							type="button"
							aria-expanded={editing === c.id}
							aria-label="Rediger «{c.name}»"
							title="Rediger"
							onclick={() => {
								editing = editing === c.id ? null : c.id;
								confirmDelete = null;
							}}><Icon name="edit" size={15} /></button
						>
					</div>
					{#if editing === c.id}
						<form method="POST" action="?/categoryUpdate" use:enhance={submit({ onsuccess: () => (editing = null) })} class="edit">
							<input type="hidden" name="id" value={c.id} />
							<label class="field">
								<span>Navn</span>
								<input class="input" name="name" value={c.name} required maxlength="80" />
							</label>
							<fieldset class="swatches">
								<legend>Farge (valgfri – en prikk ved navnet)</legend>
								<label class="sw" title="Ingen farge">
									<input type="radio" name="color" value="none" checked={!c.color} />
									<span class="ring none"></span>
									<span class="sr-only">Ingen farge</span>
								</label>
								{#each colors as col (col.id)}
									<label class="sw" title={col.name}>
										<input type="radio" name="color" value={col.id} checked={c.color === col.id} />
										<span class="ring" style:background={col.hex}></span>
										<span class="sr-only">{col.name}</span>
									</label>
								{/each}
							</fieldset>
							<label class="field">
								<span>Tekst under overskriften (valgfri)</span>
								<textarea class="input" name="description" rows="2" maxlength="500" placeholder="F.eks. kontaktperson eller hva som er levert">{c.description}</textarea>
							</label>
							<div class="buttons">
								<button class="btn primary" type="submit">Lagre</button>
								<button class="btn ghost" type="button" onclick={() => (editing = null)}>Avbryt</button>
								<span class="grow"></span>
								{#if confirmDelete === c.id}
									<button class="btn danger solid" type="submit" formaction="?/categoryDelete">Slett «{c.name}»</button>
								{:else}
									<button class="btn danger" type="button" onclick={() => (confirmDelete = c.id)}><Icon name="trash" size={16} /> Slett</button>
								{/if}
							</div>
							{#if confirmDelete === c.id}
								<p class="hint">Albumene blir liggende i {where}, bare uten kategori.</p>
							{/if}
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<form method="POST" action="?/categoryCreate" use:enhance={submit({ onsuccess: () => (newName = '') })} class="new">
		<label class="sr-only" for="new-category">Ny kategori</label>
		<input
			id="new-category"
			class="input"
			name="name"
			bind:value={newName}
			maxlength="80"
			placeholder={categories.length ? 'Ny kategori' : 'Første kategori, f.eks. et rederi'}
			required
		/>
		<button class="btn" type="submit" disabled={!newName.trim()}><Icon name="plus" size={16} /> Legg til</button>
	</form>

	{#if categories.length}
		<div class="styles-head">
			<h3>Slik ser kundene det</h3>
		</div>
		<form method="POST" action="?/categoryStyle" use:enhance={submit()} class="styles">
			{#each STYLES as st (st.id)}
				{@const on = (style ?? 'sections') === st.id}
				<button class="style" class:on type="submit" name="style" value={st.id} aria-pressed={on}>
					<svg viewBox="0 0 120 72" aria-hidden="true">
						{#if st.id === 'sections'}
							<rect x="6" y="5" width="34" height="5" rx="2.5" class="h" />
							<rect x="6" y="14" width="108" height="1" class="l" />
							{#each [6, 43, 80] as x (x)}<rect {x} y="19" width="34" height="17" rx="2" class="c" />{/each}
							<rect x="6" y="42" width="26" height="5" rx="2.5" class="h" />
							<rect x="6" y="51" width="108" height="1" class="l" />
							{#each [6, 43] as x (x)}<rect {x} y="56" width="34" height="16" rx="2" class="c" />{/each}
						{:else if st.id === 'tags'}
							{#each [0, 1] as r (r)}
								{#each [6, 43, 80] as x, k (x)}
									<rect {x} y={6 + r * 34} width="34" height="19" rx="2" class="c" />
									<circle cx={x + 2} cy={29 + r * 34} r="1.6" class={k === 2 ? 'h' : 'a'} />
									<rect x={x + 6} y={27.8 + r * 34} width="16" height="2.4" rx="1.2" class="t" />
								{/each}
							{/each}
						{:else if st.id === 'filter'}
							<rect x="6" y="5" width="18" height="8" rx="4" class="h" />
							<rect x="27" y="5" width="22" height="8" rx="4" class="p" />
							<rect x="52" y="5" width="20" height="8" rx="4" class="p" />
							{#each [0, 1] as r (r)}
								{#each [6, 43, 80] as x (x)}<rect {x} y={20 + r * 26} width="34" height="20" rx="2" class="c" />{/each}
							{/each}
						{:else if st.id === 'boxes'}
							{#each [0, 1] as r (r)}
								<rect x="4" y={3 + r * 35} width="112" height="31" rx="5" class="b" />
								<rect x="9" y={8 + r * 35} width="22" height="4" rx="2" class="h" />
								{#each [9, 44, 79] as x (x)}<rect {x} y={16 + r * 35} width="32" height="14" rx="2" class="c" />{/each}
							{/each}
						{:else if st.id === 'rows'}
							{#each [0, 1] as r (r)}
								<rect x="6" y={5 + r * 35} width="28" height="5" rx="2.5" class="h" />
								{#each [6, 46, 86] as x (x)}<rect {x} y={14 + r * 35} width="36" height="19" rx="2" class="c" />{/each}
								<path d="M110 {20 + r * 35} l4 3.5 -4 3.5" class="ar" />
							{/each}
						{:else if st.id === 'stacks'}
							{#each [6, 45, 84] as x (x)}
								<rect x={x + 4} y="14" width="22" height="28" rx="2" class="s2" />
								<rect x={x + 2} y="18" width="26" height="28" rx="2" class="s1" />
								<rect {x} y="22" width="30" height="28" rx="2" class="c" />
								<rect {x} y="55" width="20" height="4" rx="2" class="t" />
							{/each}
						{:else}
							{#each [0, 1] as r (r)}
								{#each [6, 43, 80] as x (x)}<rect {x} y={6 + r * 34} width="34" height="26" rx="2" class="c" />{/each}
							{/each}
						{/if}
					</svg>
					<span class="sname">{#if on}<Icon name="check" size={14} />{/if}{st.name}</span>
					<span class="sdesc">{st.desc}</span>
				</button>
			{/each}
		</form>
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
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	h2 {
		font-size: 17px;
	}
	h3 {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: 0;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.linkish {
		color: var(--muted);
		font-size: 13px;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.linkish:hover {
		color: var(--text);
	}
	.cats {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}
	.cats li + li {
		border-top: 1px solid var(--line);
	}
	.cats li.open {
		background: var(--surface-2);
	}
	.cat {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 6px 6px 12px;
		min-height: 44px;
	}
	.cdot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 999px;
	}
	.cdot.none {
		border: 1.5px solid var(--faint);
	}
	.cname {
		flex: 1;
		min-width: 0;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ccount {
		min-width: 22px;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--muted);
		font-size: 12px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.mini-form {
		display: flex;
		margin: 0;
	}
	.mini {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.mini:hover:not(:disabled) {
		background: var(--surface-3);
		color: var(--text);
	}
	.mini:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.edit {
		display: grid;
		gap: 12px;
		padding: 4px 12px 14px;
	}
	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.swatches legend {
		margin-bottom: 6px;
		font-size: 13px;
		color: var(--muted);
	}
	.sw {
		position: relative;
		display: grid;
		place-items: center;
		width: 29px;
		height: 30px;
		cursor: pointer;
	}
	.sw input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.ring {
		width: 19px;
		height: 19px;
		border-radius: 999px;
		box-shadow: 0 0 0 2px var(--surface-2);
		transition: box-shadow 0.12s;
	}
	.ring.none {
		border: 1.5px dashed var(--faint);
	}
	.sw input:checked + .ring {
		box-shadow:
			0 0 0 2px var(--surface-2),
			0 0 0 4px var(--text);
	}
	.sw input:focus-visible + .ring {
		outline: 2px solid var(--accent);
		outline-offset: 4px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.grow {
		flex: 1;
	}
	.new {
		display: flex;
		gap: 8px;
	}
	.new .input {
		flex: 1;
		min-width: 0;
	}
	.styles-head {
		margin-top: 4px;
	}
	.styles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
	}
	.style {
		display: grid;
		gap: 4px;
		padding: 8px 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--bg);
		color: var(--muted);
		text-align: left;
		font: inherit;
		cursor: pointer;
		transition:
			border-color 0.15s,
			color 0.15s,
			background 0.15s;
	}
	.style:hover {
		border-color: #3a3a40;
		color: var(--text);
	}
	.style.on {
		border-color: var(--accent);
		background: var(--surface-2);
		color: var(--text);
	}
	.style svg {
		width: 100%;
		height: auto;
		aspect-ratio: 120 / 72;
		margin-bottom: 2px;
		border-radius: 6px;
		background: var(--surface);
	}
	.style svg :global(.c) {
		fill: currentColor;
		opacity: 0.22;
	}
	.style svg :global(.h) {
		fill: currentColor;
		opacity: 0.8;
	}
	.style svg :global(.a) {
		fill: #3987e5;
	}
	.style svg :global(.p) {
		fill: none;
		stroke: currentColor;
		stroke-width: 1;
		opacity: 0.45;
	}
	.style svg :global(.l) {
		fill: currentColor;
		opacity: 0.3;
	}
	.style svg :global(.t) {
		fill: currentColor;
		opacity: 0.45;
	}
	.style svg :global(.b) {
		fill: currentColor;
		fill-opacity: 0.05;
		stroke: currentColor;
		stroke-opacity: 0.35;
	}
	.style svg :global(.s1) {
		fill: currentColor;
		opacity: 0.14;
	}
	.style svg :global(.s2) {
		fill: currentColor;
		opacity: 0.08;
	}
	.style svg :global(.ar) {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.7;
	}
	.sname {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.sdesc {
		font-size: 12px;
		line-height: 1.35;
	}
</style>
