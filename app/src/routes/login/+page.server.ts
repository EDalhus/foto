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
import { cleanEmail, createLoginToken, findGuestByEmail, LOGIN_LINK_MINUTES, linkSendAllowed } from '$lib/server/guests';
import { loginMail, sendMail } from '$lib/server/mail';
import { HttpError } from '$lib/server/tree';
import type { Actions, PageServerLoad } from './$types';

function safeNext(value: string | null, fallback = '/admin') {
	return value && value.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next'), locals.user.role === 'admin' ? '/admin' : '/'));
	return {};
};

export const actions: Actions = {
	/** Administrator: e-post og passord. */
	password: async ({ request, cookies, url, getClientAddress }) => {
		const ip = getClientAddress();
		if (!loginAllowed(ip)) return fail(429, { error: 'For mange forsøk. Vent et kvarter og prøv igjen.', email: '', mode: 'password' });
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const user = email ? findUserByEmail(email) : undefined;
		const ok = await verifyPassword(password, user?.password_hash ?? null);
		if (!user || !ok) {
			recordLoginFailure(ip);
			return fail(400, { error: 'Feil e-post eller passord.', email, mode: 'password' });
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
		redirect(303, safeNext(url.searchParams.get('next'), user.role === 'admin' ? '/admin' : '/'));
	},

	/** Gjest: lenke på e-post. Svaret er det samme uansett om adressen finnes, så ingen kan sjekke hvem som har tilgang. */
	link: async ({ request, url, getClientAddress }) => {
		const form = await request.formData();
		let email: string;
		try {
			email = cleanEmail(form.get('email'));
		} catch (err) {
			return fail(400, { error: err instanceof HttpError ? err.message : 'Ugyldig e-post.', email: String(form.get('email') ?? ''), mode: 'link' });
		}
		if (!linkSendAllowed(`ip:${getClientAddress()}`, 10)) {
			return fail(429, { error: 'For mange forsøk. Vent et kvarter og prøv igjen.', email, mode: 'link' });
		}
		const guest = findGuestByEmail(email);
		if (guest && linkSendAllowed(`mail:${email}`, 3)) {
			const { token } = createLoginToken(guest.id, 'login');
			const next = safeNext(url.searchParams.get('next'), '');
			const link = `${url.origin}/login/lenke/${token}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
			try {
				await sendMail(loginMail({ to: guest.email, name: guest.name, url: link, invite: false, validFor: `${LOGIN_LINK_MINUTES} minutter` }));
			} catch (err) {
				console.error('[foto] Kunne ikke sende innloggingslenke:', err);
				return fail(503, { error: 'Klarte ikke å sende e-posten akkurat nå. Prøv igjen om litt.', email, mode: 'link' });
			}
		}
		return { sent: email };
	}
};
