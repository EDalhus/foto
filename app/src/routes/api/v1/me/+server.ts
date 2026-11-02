import { json } from '@sveltejs/kit';
import { api, requireAdmin } from '$lib/server/http';
import { config } from '$lib/server/config';
import type { RequestHandler } from './$types';

/** Brukes av Lightroom-pluginen for å teste tilkoblingen. */
export const GET: RequestHandler = (event) =>
	api(() => {
		const user = requireAdmin(event);
		return json({ ok: true, user: { email: user.email, name: user.name }, site: config.siteTitle, apiVersion: 1 });
	});
