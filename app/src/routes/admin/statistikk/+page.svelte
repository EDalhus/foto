<script lang="ts">
	import BarChart, { type Bar } from '$lib/components/BarChart.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { formatLocal, plural } from '$lib/format';

	let { data } = $props();

	const PERIODS = [
		{ v: 7, label: '7 dager' },
		{ v: 30, label: '30 dager' },
		{ v: 90, label: '90 dager' },
		{ v: 365, label: '12 måneder' }
	];
	const monthly = $derived(data.period === 365);
	const dayLong = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
	const monthLong = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	const monthShort = new Intl.DateTimeFormat('nb-NO', { month: 'short', timeZone: 'UTC' });
	const at = (key: string) => new Date(key.length === 7 ? `${key}-15T12:00:00Z` : `${key}T12:00:00Z`);
	const fmt = (n: number) => n.toLocaleString('nb-NO');

	const bars: Bar[] = $derived(
		data.series.map((p) => {
			const d = at(p.key);
			const parts = [p.downloads ? plural(p.downloads, 'bilde lastet ned', 'bilder lastet ned') : '', p.zips ? plural(p.zips, 'zip', 'zip') : '']
				.filter(Boolean)
				.join(' · ');
			return {
				short: monthly ? monthShort.format(d).replace('.', '') : `${d.getUTCDate()}.${d.getUTCMonth() + 1}`,
				label: monthly ? monthLong.format(d) : dayLong.format(d),
				value: p.views,
				detail: parts || undefined
			};
		})
	);
	const topMax = $derived(Math.max(1, ...data.top.map((r) => r.views)));
	const empty = $derived(!data.totals.views && !data.totals.downloads && !data.totals.zips);

	const MODE = { public: 'Offentlig', private: 'Privat', client: 'Kunde' } as const;
	const MODE_ICON = { public: 'globe', private: 'lock', client: 'user' } as const;
</script>

<svelte:head><title>Statistikk – Administrer</title></svelte:head>

<div class="head">
	<div>
		<h1>Statistikk</h1>
		<p class="muted">Visninger og nedlastinger på nettstedet. Du selv og roboter telles ikke, og ingen IP-adresser lagres.</p>
	</div>
	<nav class="periods" aria-label="Periode">
		{#each PERIODS as p (p.v)}
			<a class="chip" class:on={data.period === p.v} aria-current={data.period === p.v ? 'page' : undefined} href="?periode={p.v}" data-sveltekit-noscroll
				>{p.label}</a
			>
		{/each}
	</nav>
</div>

<div class="kpis">
	<div class="kpi">
		<span class="label">Visninger</span>
		<span class="value">{fmt(data.totals.views)}</span>
		<span class="sub">av mapper og album</span>
	</div>
	<div class="kpi">
		<span class="label">Bilder lastet ned</span>
		<span class="value">{fmt(data.totals.downloads)}</span>
		<span class="sub">i full oppløsning</span>
	</div>
	<div class="kpi">
		<span class="label">Hele album lastet ned</span>
		<span class="value">{fmt(data.totals.zips)}</span>
		<span class="sub">som zip</span>
	</div>
	<div class="kpi">
		<span class="label">Gjester innom</span>
		<span class="value">{fmt(data.activeGuests)}</span>
		<span class="sub">innloggede gjester</span>
	</div>
</div>

<section class="panel">
	<h2>Visninger per {monthly ? 'måned' : 'dag'}</h2>
	{#if empty}
		<p class="muted">Ingen visninger i perioden ennå. Tallene kommer etter hvert som noen ser bildene.</p>
	{:else}
		<BarChart {bars} unit={['visning', 'visninger']} />
		<details class="table-view">
			<summary>Vis tallene</summary>
			<table>
				<thead><tr><th>{monthly ? 'Måned' : 'Dag'}</th><th class="num">Visninger</th><th class="num">Bilder lastet ned</th><th class="num">Zip</th></tr></thead>
				<tbody>
					{#each data.series as p, i (p.key)}
						<tr><td>{bars[i].label}</td><td class="num">{fmt(p.views)}</td><td class="num">{fmt(p.downloads)}</td><td class="num">{fmt(p.zips)}</td></tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</section>

<div class="cols">
	<section class="panel">
		<h2>Mest sett</h2>
		{#if data.top.length}
			<table class="top">
				<thead><tr><th>Mappe eller album</th><th class="num">Visninger</th><th class="num">Nedlastet</th></tr></thead>
				<tbody>
					{#each data.top as r (r.nodeId)}
						<tr>
							<td>
								<a href="/admin/node/{r.nodeId}" class="name">
									<Icon name={r.type === 'folder' ? 'folder' : 'image'} size={15} />
									<span>{r.name}</span>
								</a>
								<span class="faint small">
									{#if r.trail}{r.trail} · {/if}<Icon name={MODE_ICON[r.mode]} size={11} />
									{MODE[r.mode]}
								</span>
							</td>
							<td class="num">
								<span class="meter" aria-hidden="true"><i style:width="{(r.views / topMax) * 100}%"></i></span>
								{fmt(r.views)}
							</td>
							<td class="num">{fmt(r.downloads)}{#if r.zips}&nbsp;<span class="faint">+ {r.zips} zip</span>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="muted">Ingenting er sett i perioden.</p>
		{/if}
	</section>

	<section class="panel">
		<h2>Gjester</h2>
		<p class="hint">Hva innloggede gjester (familie, venner og kunder) har sett og lastet ned.</p>
		{#if data.guests.length}
			<ul class="guests">
				{#each data.guests as g (g.userId + g.nodeId)}
					<li>
						<div class="who">
							<strong>{g.name || g.email}</strong>
							<a class="faint small" href="/admin/node/{g.nodeId}">{g.node}</a>
						</div>
						<div class="what small">
							<span>{plural(g.views, 'visning', 'visninger')}</span>
							{#if g.downloads}<span>· {plural(g.downloads, 'bilde', 'bilder')} lastet ned</span>{/if}
							{#if g.zips}<span>· hele albumet {g.zips === 1 ? 'én gang' : `${g.zips} ganger`}</span>{/if}
							<span class="faint">· sist {formatLocal(g.lastAt)}</span>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Ingen gjester har vært innom i perioden.</p>
		{/if}
	</section>
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 20px;
	}
	h1 {
		font-size: 28px;
	}
	.head p {
		margin-top: 6px;
		max-width: 62ch;
	}
	.periods {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: 34px;
		padding: 0 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--muted);
		font-size: 13px;
	}
	.chip:hover {
		color: var(--text);
	}
	.chip.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}
	.kpi {
		display: grid;
		gap: 2px;
		padding: 16px 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
	}
	.kpi .label {
		font-size: 13px;
		color: var(--muted);
	}
	.kpi .value {
		font-size: 32px;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
	.kpi .sub {
		font-size: 12px;
		color: var(--faint);
	}
	.panel {
		display: grid;
		gap: 14px;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
		margin-bottom: 16px;
		min-width: 0;
	}
	h2 {
		font-size: 17px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
		margin-top: -8px;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 16px;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.table-view summary {
		cursor: pointer;
		font-size: 13px;
		color: var(--muted);
	}
	.table-view summary:hover {
		color: var(--text);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
	}
	.table-view table {
		margin-top: 10px;
	}
	th {
		text-align: left;
		font-size: 12px;
		font-weight: 500;
		color: var(--faint);
		padding: 6px 8px;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 8px;
		border-bottom: 1px solid var(--line);
		vertical-align: top;
	}
	tr:last-child td {
		border-bottom: 0;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.top td:first-child {
		display: grid;
		gap: 2px;
	}
	.name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}
	.name :global(svg) {
		color: var(--muted);
		flex: none;
	}
	.name:hover span {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.small {
		font-size: 12px;
	}
	.faint.small :global(svg) {
		vertical-align: -1px;
	}
	.meter {
		display: inline-block;
		position: relative;
		width: 64px;
		height: 6px;
		margin-right: 8px;
		border-radius: 999px;
		background: var(--surface-3);
		overflow: hidden;
		vertical-align: 1px;
	}
	.meter i {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: #3987e5;
	}
	.guests {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}
	.guests li {
		display: grid;
		gap: 2px;
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}
	.guests li:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}
	.who a:hover {
		color: var(--text);
		text-decoration: underline;
	}
	.what {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		color: var(--muted);
	}
	@media (max-width: 600px) {
		.meter {
			display: none;
		}
	}
</style>
