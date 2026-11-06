import { api, readJson } from '$lib/server/http';
import { recordView } from '$lib/server/stats';
import { canView, getNode, HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/**
 * Telles fra nettleseren når en mappe eller et album faktisk vises (ikke når SvelteKit henter siden i forkant
 * fordi musa er over en lenke). Svarer alltid 204, også når visningen ikke telles.
 */
export const POST: RequestHandler = (event) =>
	api(async () => {
		const body = await readJson<{ node?: unknown }>(event.request);
		const node = typeof body.node === 'string' ? getNode(body.node) : null;
		if (!node || !canView(node, event.locals.user)) throw new HttpError(404, 'Finnes ikke');
		recordView(node, event.locals.user, event.getClientAddress(), event.request.headers.get('user-agent'));
		return new Response(null, { status: 204 });
	});
