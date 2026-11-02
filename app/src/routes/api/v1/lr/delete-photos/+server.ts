import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { deletePhotos } from '$lib/server/photos';
import { HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Slett flere bilder. Svarer med alle id-er som nå er borte (også de som allerede var slettet). */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<{ ids?: unknown }>(event.request);
		if (!Array.isArray(body.ids)) throw new HttpError(400, 'ids mangler.');
		const ids = body.ids.map(String).slice(0, 5000);
		await deletePhotos(ids);
		return json({ ok: true, deleted: ids });
	});
