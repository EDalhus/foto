import { error, redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/tree';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	if (!isAdmin(locals.user)) error(403, 'Ingen tilgang');
	return {};
};
