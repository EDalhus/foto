import { onlyExpired } from '$lib/server/guests';
import { isAdmin, sharedRoots, visibleChildren } from '$lib/server/tree';
import { cardViews } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const shared = sharedRoots(locals.user);
	const sharedIds = new Set(shared.map((n) => n.id));
	return {
		shared: cardViews(shared, locals.user),
		// Det som allerede står under «Delt med deg», vises ikke to ganger.
		accessExpired: !!locals.user && !isAdmin(locals.user) && !shared.length && onlyExpired(locals.user.id),
		cards: cardViews(visibleChildren(null, locals.user).filter((n) => !sharedIds.has(n.id)), locals.user)
	};
};
