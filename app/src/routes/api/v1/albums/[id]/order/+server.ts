import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { reorder } from '$lib/server/photos';
import { getNode, HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const node = getNode(event.params.id);
		if (!node || node.type !== 'album') throw new HttpError(404, 'Albumet finnes ikke.');
		const body = await readJson<{ photoIds?: unknown }>(event.request);
		if (!Array.isArray(body.photoIds)) throw new HttpError(400, 'photoIds mangler.');
		reorder(node.id, body.photoIds.map(String));
		return json({ ok: true });
	});
