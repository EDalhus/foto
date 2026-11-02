import { fail } from '@sveltejs/kit';
import { findUserByEmail, hashPassword, SESSION_COOKIE, verifyPassword } from '$lib/server/auth';
import { run } from '$lib/server/db';
import { sha256 } from '$lib/server/ids';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ email: locals.user!.email });

export const actions: Actions = {
	password: async ({ request, locals, cookies }) => {
		const form = await request.formData();
		const current = String(form.get('current') ?? '');
		const next = String(form.get('next') ?? '');
		const repeat = String(form.get('repeat') ?? '');
		const user = findUserByEmail(locals.user!.email);
		if (!user || !(await verifyPassword(current, user.password_hash))) return fail(400, { error: 'Nåværende passord er feil.' });
		if (next.length < 12) return fail(400, { error: 'Det nye passordet må ha minst 12 tegn.' });
		if (next !== repeat) return fail(400, { error: 'De to nye passordene er ikke like.' });
		run(`UPDATE users SET password_hash = ? WHERE id = ?`, await hashPassword(next), user.id);
		// Logg ut alle andre steder enn her (f.eks. noen som kjente det gamle passordet).
		const others = run(
			`DELETE FROM sessions WHERE user_id = ? AND id != ?`,
			user.id,
			sha256(cookies.get(SESSION_COOKIE) ?? '')
		);
		return { saved: true, loggedOut: Number(others.changes) };
	}
};
