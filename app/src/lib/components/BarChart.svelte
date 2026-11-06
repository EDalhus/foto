<script lang="ts" module>
	/**
	 * Søylediagram for én serie (f.eks. visninger per dag). Én akse, søylene vokser fra én grunnlinje,
	 * maks 24 px brede med 4 px avrundet topp og minst 2 px luft mellom. Verdien vises når man holder over
	 * en søyle; alle tallene finnes også i en tabell ved siden av (for tastatur og skjermleser).
	 */
	export interface Bar {
		/** Kort etikett på aksen, f.eks. «5.11». */
		short: string;
		/** Hele etiketten i verktøytipset, f.eks. «5. november». */
		label: string;
		value: number;
		/** Ekstra linje i verktøytipset, f.eks. «3 bilder lastet ned». */
		detail?: string;
	}
</script>

<script lang="ts">
	let {
		bars,
		unit,
		height = 200,
		compact = false
	}: { bars: Bar[]; unit: [string, string]; height?: number; compact?: boolean } = $props();

	let width = $state(0);
	let hover = $state<number | null>(null);

	const left = $derived(compact ? 0 : 34);
	const bottom = $derived(compact ? 0 : 24);
	const top = 8;
	const plotW = $derived(Math.max(0, width - left));
	const plotH = $derived(Math.max(0, height - top - bottom));

	// Pene tall på aksen: 0, 5, 10 … eller 0, 50, 100 …
	function niceStep(max: number, count: number) {
		const raw = Math.max(1, max) / count;
		const pow = 10 ** Math.floor(Math.log10(raw));
		for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return Math.max(1, m * pow);
		return 10 * pow;
	}
	const max = $derived(Math.max(0, ...bars.map((b) => b.value)));
	const step = $derived(niceStep(max, compact ? 1 : 3));
	const yMax = $derived(Math.max(step, Math.ceil(max / step) * step));
	const ticks = $derived(Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step));

	const band = $derived(bars.length ? plotW / bars.length : 0);
	const barW = $derived(Math.max(1, Math.min(24, band - 2)));
	const y = (v: number) => top + plotH - (v / yMax) * plotH;

	/** Søyle med avrundet topp (4 px) og rett bunn. */
	function barPath(i: number, v: number) {
		const h = (v / yMax) * plotH;
		if (h <= 0) return '';
		const x = left + i * band + (band - barW) / 2;
		const r = Math.min(4, barW / 2, h);
		const y0 = top + plotH;
		const y1 = y0 - h;
		return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + barW - r}Q${x + barW},${y1} ${x + barW},${y1 + r}V${y0}Z`;
	}

	// Noen få datoer under aksen (første, siste og jevnt fordelt imellom) – aldri en på hver søyle.
	const labelEvery = $derived(Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 56)))));
	const showLabel = (i: number) => i === bars.length - 1 || (i % labelEvery === 0 && bars.length - 1 - i >= labelEvery / 2);

	const fmt = (n: number) => n.toLocaleString('nb-NO');
	const tip = $derived(hover !== null ? bars[hover] : null);
	const tipX = $derived(hover !== null ? left + hover * band + band / 2 : 0);
	// Rett over søylen (eller grunnlinjen når den er tom).
	const tipY = $derived(tip ? y(tip.value) - 8 : 0);
</script>

<div class="chart" class:compact bind:clientWidth={width} style:height="{height}px">
	{#if width > 0}
		<svg {width} {height} role="img" aria-label="{bars.length} søyler, høyeste {fmt(max)} {unit[1]}">
			{#if !compact}
				{#each ticks as t (t)}
					<line class="grid" x1={left} x2={width} y1={y(t) + 0.5} y2={y(t) + 0.5} />
					<text class="tick" x={left - 8} y={y(t)} dy="0.32em" text-anchor="end">{fmt(t)}</text>
				{/each}
			{:else}
				<line class="grid" x1={0} x2={width} y1={top + plotH + 0.5} y2={top + plotH + 0.5} />
			{/if}
			{#each bars as b, i (i)}
				<path class="bar" class:on={hover === i} d={barPath(i, b.value)} />
			{/each}
			{#if !compact}
				{#each bars as b, i (i)}
					{#if showLabel(i)}
						<text class="xlabel" x={left + i * band + band / 2} y={height - 6} text-anchor="middle">{b.short}</text>
					{/if}
				{/each}
			{/if}
			<!-- Treffflatene er hele kolonnen, så små søyler er lette å treffe. -->
			{#each bars as b, i (i)}
				<rect
					class="hit"
					x={left + i * band}
					y={top}
					width={Math.max(band, 1)}
					height={plotH}
					role="img"
					aria-label="{b.label}: {fmt(b.value)} {b.value === 1 ? unit[0] : unit[1]}{b.detail ? `, ${b.detail}` : ''}"
					onpointerenter={() => (hover = i)}
					onpointerleave={() => (hover = null)}
				/>
			{/each}
		</svg>
		{#if tip}
			<div class="tip" style:left="{Math.min(Math.max(tipX, 70), width - 70)}px" style:top="{tipY}px" role="presentation">
				<span><strong>{fmt(tip.value)}</strong> {tip.value === 1 ? unit[0] : unit[1]}</span>
				<span class="when">{tip.label}</span>
				{#if tip.detail}<span class="detail">{tip.detail}</span>{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.chart {
		position: relative;
		width: 100%;
	}
	svg {
		display: block;
		overflow: visible;
	}
	.grid {
		stroke: var(--line);
		stroke-width: 1;
	}
	.tick,
	.xlabel {
		fill: var(--faint);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.bar {
		fill: #3987e5;
		transition: fill 0.12s;
	}
	.bar.on {
		fill: #6da7ec;
	}
	.hit {
		fill: transparent;
		outline: none;
		cursor: default;
	}
	.tip {
		position: absolute;
		transform: translate(-50%, -100%);
		display: grid;
		gap: 1px;
		min-width: 120px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid #34343a;
		background: #1f1f23;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
		font-size: 12px;
		color: var(--muted);
		pointer-events: none;
		white-space: nowrap;
		z-index: 3;
	}
	.tip strong {
		font-size: 15px;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.when {
		color: var(--text);
	}
</style>
