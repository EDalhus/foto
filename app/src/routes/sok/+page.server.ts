import { search } from '$lib/server/search';
import { getTree } from '$lib/server/tree';
import { cardViews, photoView } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 200).trim();
	if (!q) return { q, cards: [], photos: [], more: false };
	const result = search(q, locals.user);
	const { byId } = getTree();
	return {
		q,
		cards: cardViews(result.nodes, locals.user),
		photos: result.photos.map((p) => photoView(p, byId.get(p.album_id)!, locals.user)),
		more: result.more
	};
};
