import { visibleChildren } from '$lib/server/tree';
import { cardViews } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({
	cards: cardViews(visibleChildren(null, locals.user), locals.user)
});
