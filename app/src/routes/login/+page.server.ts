import { fail, redirect } from '@sveltejs/kit';
import {
	clearLoginFailures,
	createSession,
	findUserByEmail,
	loginAllowed,
	recordLoginFailure,
	SESSION_COOKIE,
	verifyPassword
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function safeNext(value: string | null) {
	return value && value.startsWith('/') && !value.startsWith('//') ? value : '/admin';
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const ip = getClientAddress();
		if (!loginAllowed(ip)) return fail(429, { error: 'For mange forsøk. Vent et kvarter og prøv igjen.', email: '' });
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const user = email ? findUserByEmail(email) : undefined;
		const ok = await verifyPassword(password, user?.password_hash ?? null);
		if (!user || !ok) {
			recordLoginFailure(ip);
			return fail(400, { error: 'Feil e-post eller passord.', email });
		}
		clearLoginFailures(ip);
		const session = createSession(user.id);
		cookies.set(SESSION_COOKIE, session.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			expires: session.expires
		});
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
