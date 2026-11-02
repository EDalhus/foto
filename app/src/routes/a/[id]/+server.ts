import { error, redirect } from '@sveltejs/kit';
import { canView, getNode, pathOf } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Fast lenke til en mappe/et album, som fungerer selv om navnet endres. */
export const GET: RequestHandler = ({ params, locals }) => {
	const node = getNode(params.id);
	if (!node || !canView(node, locals.user)) error(404);
	redirect(302, pathOf(node));
};
