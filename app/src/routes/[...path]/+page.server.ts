import { error, redirect } from '@sveltejs/kit';
import { listPhotos } from '$lib/server/photos';
import { canView, isAdmin, pathOf, resolvePath, visibleChildren } from '$lib/server/tree';
import { cardViews, crumbs, photoView } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, url }) => {
	const segments = params.path.split('/').filter(Boolean);
	const node = resolvePath(segments);
	if (!node || !canView(node, locals.user)) {
		// Private album skal se ut som om de ikke finnes – men gi innloggingsmulighet.
		if (node && !locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
		error(404, 'Finner ikke siden');
	}
	const canonical = pathOf(node);
	if (decodeURIComponent(url.pathname).replace(/\/+$/, '') !== canonical) redirect(301, canonical);

	const base = {
		node: {
			id: node.id,
			type: node.type,
			name: node.name,
			description: node.description,
			path: canonical,
			isPrivate: node.effectivePrivate,
			photoCount: node.photoCount,
			albumCount: node.albumCount,
			latest: node.latest
		},
		crumbs: crumbs(node, locals.user),
		isAdmin: isAdmin(locals.user)
	};

	if (node.type === 'folder') {
		return { ...base, cards: cardViews(visibleChildren(node, locals.user), locals.user), photos: [], downloadAll: null };
	}
	const photos = listPhotos(node.id).map((p) => photoView(p, node, locals.user));
	const taken = photos.map((p) => p.takenAt).filter((t): t is number => !!t);
	return {
		...base,
		cards: [],
		photos,
		range: taken.length ? { from: Math.min(...taken), to: Math.max(...taken) } : null,
		downloadAll: (node.allow_download || isAdmin(locals.user)) && photos.length ? `/download/album/${node.id}` : null
	};
};
