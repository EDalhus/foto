import { json } from '@sveltejs/kit';
import { api, requireAdmin } from '$lib/server/http';
import { listPhotos } from '$lib/server/photos';
import { getNode, HttpError, type TreeNode } from '$lib/server/tree';
import { mediaUrl } from '$lib/server/views';
import type { RequestHandler } from './$types';

const PER_ALBUM = 80;
const TOTAL = 1200;

/** Bildene man kan velge forsidebilde blant: albumets egne, eller alle album i mappa (gruppert). */
export const GET: RequestHandler = (event) =>
	api(() => {
		requireAdmin(event);
		const node = getNode(event.params.id);
		if (!node) throw new HttpError(404, 'Finnes ikke.');
		const albums: TreeNode[] = [];
		const walk = (n: TreeNode) => {
			if (n.type === 'album') albums.push(n);
			else n.children.forEach(walk);
		};
		walk(node);
		let left = TOTAL;
		const sections = [];
		for (const a of albums) {
			if (left <= 0) break;
			const all = listPhotos(a.id);
			if (!all.length) continue;
			const photos = all.slice(0, Math.min(node.type === 'album' ? TOTAL : PER_ALBUM, left));
			left -= photos.length;
			sections.push({
				album: { id: a.id, name: a.name, count: all.length },
				photos: photos.map((p) => ({
					id: p.id,
					src: mediaUrl(p, 's.webp'),
					color: p.color,
					title: p.title || p.filename
				}))
			});
		}
		return json({ sections }, { headers: { 'cache-control': 'private, no-store' } });
	});
