import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { search } from '$lib/server/search';
import { canView, getTree, sharedRoots, visibleChildren, type TreeNode } from '$lib/server/tree';
import { cardViews, imageView } from '$lib/server/views';
import { watermarkFor } from '$lib/server/watermark';
import { formatDate, formatRange, plural } from '$lib/format';
import type { SearchHit } from '$lib/types';
import type { RequestHandler } from './$types';

const PHOTOS = 8;

/** Første og siste bildedato under en mappe/et album (mapper: bare det brukeren ser). */
function span(n: TreeNode, user: App.Locals['user']): [number, number] | null {
	if (n.type === 'album') return n.photoCount ? [n.earliest, n.latest] : null;
	let out: [number, number] | null = null;
	for (const c of n.children) {
		if (!canView(c, user)) continue;
		const s = span(c, user);
		if (s) out = out ? [Math.min(out[0], s[0]), Math.max(out[1], s[1])] : s;
	}
	return out;
}

function nodeHits(nodes: TreeNode[], user: App.Locals['user']): SearchHit[] {
	const cards = cardViews(nodes, user);
	return nodes.map((n, i) => {
		const c = cards[i];
		const s = span(n, user);
		const parent = n.parent && canView(n.parent, user) ? n.parent.name : '';
		return {
			id: n.id,
			kind: n.type,
			name: n.name,
			href: c.path,
			meta: [
				n.type === 'folder' ? 'Mappe' : parent || 'Album',
				s ? formatRange(s[0], s[1]) : '',
				n.type === 'folder' ? plural(n.albumCount, 'album', 'album') : plural(n.photoCount, 'bilde', 'bilder')
			]
				.filter(Boolean)
				.join(' · '),
			isPrivate: n.effectivePrivate,
			thumb: c.cover ? { src: c.cover.src, srcset: c.cover.srcset, color: c.cover.color } : null
		};
	});
}

/** Til søkeboksen (⌘K): mapper/album og noen bilder. Uten søkeord: forslag (toppnivået og de nyeste albumene). */
export const GET: RequestHandler = ({ url, locals }) =>
	api(() => {
		const user = locals.user;
		const q = (url.searchParams.get('q') ?? '').slice(0, 200).trim();

		if (!q) {
			const seen = new Set<string>();
			const pick = (list: TreeNode[]) => list.filter((n) => n.photoCount > 0 && !seen.has(n.id) && seen.add(n.id));
			const top = pick([...sharedRoots(user), ...visibleChildren(null, user)]);
			const albums = [...getTree().byId.values()]
				.filter((n) => n.type === 'album' && n.photoCount > 0 && canView(n, user))
				.sort((a, b) => b.latest - a.latest);
			const recent = pick(albums).slice(0, 6);
			return json({ q, nodes: nodeHits([...top.slice(0, 8), ...recent], user), photos: [], more: false });
		}

		const result = search(q, user, PHOTOS + 1);
		const { byId } = getTree();
		const photos: SearchHit[] = result.photos.slice(0, PHOTOS).map((p) => {
			const album = byId.get(p.album_id)!;
			const img = imageView(p, watermarkFor(album, user));
			return {
				id: p.id,
				kind: 'photo',
				name: p.title || p.filename.replace(/\.[^.]+$/, ''),
				href: `/i/${p.id}`,
				meta: [album.name, formatDate(p.taken_at)].filter(Boolean).join(' · '),
				isPrivate: album.effectivePrivate,
				thumb: { src: img.src, srcset: img.srcset, color: img.color }
			};
		});
		return json({
			q,
			nodes: nodeHits(result.nodes.slice(0, 12), user),
			photos,
			more: result.photos.length > PHOTOS || result.nodes.length > 12
		});
	});
