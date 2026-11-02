import { error, fail, redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/tree';
import { approve, deny, findByCode } from '$lib/server/lrconnect';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params, url, getClientAddress }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	if (!isAdmin(locals.user)) error(403, 'Bare administratorer kan koble til Lightroom.');
	const r = findByCode(params.code);
	if (!r) return { state: 'missing' as const };
	return {
		state: r.status,
		code: r.code,
		device: r.device,
		sameNetwork: r.ip === getClientAddress(),
		email: locals.user.email
	};
};

export const actions: Actions = {
	approve: ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) error(403, 'Ingen tilgang');
		if (!approve(params.code, locals.user)) return fail(410, { error: 'Forespørselen har gått ut. Trykk «Koble til Foto» i Lightroom på nytt.' });
		return { done: 'approved' as const };
	},
	deny: ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) error(403, 'Ingen tilgang');
		deny(params.code);
		return { done: 'denied' as const };
	}
};
