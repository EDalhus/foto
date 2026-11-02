import { config } from '$lib/server/config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => ({
	user: locals.user ? { email: locals.user.email, name: locals.user.name, isAdmin: locals.user.role === 'admin' } : null,
	site: { title: config.siteTitle, tagline: config.siteTagline },
	origin: url.origin
});
