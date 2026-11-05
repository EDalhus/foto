import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { getNode, HttpError, updateNode } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Forsidebilde for albumet: { photo } (et bilde i albumet), eller { photo: null } for automatisk. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const node = getNode(event.params.id);
		if (!node || node.type !== 'album') throw new HttpError(404, 'Albumet finnes ikke.');
		const body = await readJson<{ photo?: unknown }>(event.request);
		const photo = typeof body.photo === 'string' && body.photo ? body.photo : null;
		updateNode(node.id, { coverPhotoId: photo });
		return json({ ok: true, cover: photo });
	});
