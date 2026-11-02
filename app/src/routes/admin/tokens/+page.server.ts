import { fail } from '@sveltejs/kit';
import { createApiToken, deleteApiToken, listApiTokens } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => ({
	tokens: listApiTokens(locals.user!.id),
	serverUrl: url.origin
});

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Gi nøkkelen et navn, f.eks. «Lightroom på MacBook».' });
		const { token, info } = createApiToken(locals.user!.id, name);
		return { created: { token, name: info.name } };
	},
	delete: async ({ request, locals }) => {
		const form = await request.formData();
		deleteApiToken(locals.user!.id, String(form.get('id') ?? ''));
		return { deleted: true };
	}
};
