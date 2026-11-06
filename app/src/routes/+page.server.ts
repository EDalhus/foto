import { onlyExpired } from '$lib/server/guests';
import { isAdmin, sharedRoots, visibleChildren } from '$lib/server/tree';
import { groupCards } from '$lib/server/categories';
import { cardViews } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const shared = sharedRoots(locals.user);
	const sharedIds = new Set(shared.map((n) => n.id));
	// Det som allerede står under «Delt med deg», vises ikke to ganger.
	const nodes = visibleChildren(null, locals.user).filter((n) => !sharedIds.has(n.id));
	const cards = cardViews(nodes, locals.user);
	return {
		shared: cardViews(shared, locals.user),
		accessExpired: !!locals.user && !isAdmin(locals.user) && !shared.length && onlyExpired(locals.user.id),
		cards,
		grouping: groupCards(null, nodes, cards)
	};
};
