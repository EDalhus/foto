import { json } from '@sveltejs/kit';
import { api, requireAdmin } from '$lib/server/http';
import { lrTree } from '$lib/server/lightroom';
import type { RequestHandler } from './$types';

/** Hele strukturen med koblingene til Lightroom – til «Synkroniser med Foto» i pluginen. */
export const GET: RequestHandler = (event) =>
	api(() => {
		requireAdmin(event);
		return json({ nodes: lrTree(event.url.searchParams.get('serviceKey'), event.url.origin) });
	});
