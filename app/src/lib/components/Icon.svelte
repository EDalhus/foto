<script lang="ts">
	const paths: Record<string, string> = {
		lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
		download: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14',
		x: 'M6 6l12 12M18 6 6 18',
		left: 'M15 5l-7 7 7 7',
		right: 'M9 5l7 7-7 7',
		info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5v-5m0-3h.01',
		link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
		folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
		image: 'M4 5h16v14H4zm0 11 5-5 4 4 2-2 5 5M15.5 9.5h.01',
		upload: 'M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 20h14',
		trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
		star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
		back: 'M19 12H5m0 0 6-6m-6 6 6 6',
		check: 'M5 12.5l4.5 4.5L19 7',
		plus: 'M12 5v14M5 12h14',
		external: 'M14 4h6v6m0-6-9 9M18 14v5H5V6h5',
		key: 'M15.5 8.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM12 12v8m0-4h3m-3 2.5h2',
		pulse: 'M3 12h4l2.5-6 5 12 2.5-6h4',
		sort: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3',
		move: 'M5 12h14m0 0-4-4m4 4-4 4M5 6h6M5 18h6',
		cloud: 'M7 18a4 4 0 0 1-.5-7.97 6 6 0 0 1 11.46 1.47A3.5 3.5 0 0 1 17.5 18z',
		clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4.5l3 2',
		users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
		mail: 'M3 6h18v12H3zm0 0 9 7 9-7',
		heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z',
		play: 'M8 5.5v13l10.5-6.5z',
		pause: 'M8.5 5v14M15.5 5v14',
		search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.5-4.5',
		sliders: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
		send: 'M4 12 20 4l-6 16-3-7zm7 1 9-9'
	};

	let { name, size = 18, label, filled = false }: { name: string; size?: number; label?: string; filled?: boolean } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill={filled ? 'currentColor' : 'none'}
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden={label ? undefined : 'true'}
	role={label ? 'img' : undefined}
	aria-label={label}
>
	<path d={paths[name] ?? ''} />
</svg>
