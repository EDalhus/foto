import { redirect } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE } from '$lib/server/auth';
import { consumeLoginToken, peekLoginToken } from '$lib/server/guests';
import { sharedRoots, getNode, pathOf } from '$lib/server/tree';
import type { Actions, PageServerLoad } from './$types';

// Lenken brukes først når personen trykker på knappen. Da kan ikke e-postprogrammer som «forhåndssjekker» lenker bruke den opp.

export const load: PageServerLoad = ({ params }) => {
	const guest = peekLoginToken(params.token);
	return guest ? { valid: true as const, email: guest.email, name: guest.name, invite: guest.purpose === 'invite' } : { valid: false as const };
};

export const actions: Actions = {
	default: ({ params, cookies, url }) => {
		const userId = consumeLoginToken(params.token);
		if (!userId) return { expired: true };
		const session = createSession(userId);
		cookies.set(SESSION_COOKIE, session.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			expires: session.expires
		});
		const next = url.searchParams.get('next');
		if (next && next.startsWith('/') && !next.startsWith('//')) redirect(303, next);
		// Har gjesten bare tilgang til én ting, gå rett dit.
		const roots = sharedRoots({ id: userId, email: '', name: '', role: 'viewer' });
		const only = roots.length === 1 ? getNode(roots[0].id) : null;
		redirect(303, only ? pathOf(only) : '/');
	}
};
