import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { deletePhotos, getPhoto, updatePhoto } from '$lib/server/photos';
import { HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<{ title?: string; caption?: string }>(event.request);
		updatePhoto(event.params.id, body);
		return json({ ok: true });
	});

export const DELETE: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		if (!getPhoto(event.params.id)) throw new HttpError(404, 'Bildet finnes ikke.');
		await deletePhotos([event.params.id]);
		return json({ ok: true });
	});
