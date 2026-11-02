import { json } from '@sveltejs/kit';
import { api, keywordsFrom, optionalString, readForm, requireAdmin } from '$lib/server/http';
import { getPhoto, ingest } from '$lib/server/photos';
import { HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Erstatt bildefila (ny versjon fra Lightroom) – samme ID, samme plass i albumet. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const existing = getPhoto(event.params.id);
		if (!existing) throw new HttpError(404, 'Bildet finnes ikke.');
		const form = await readForm(event.request);
		const file = form.get('file');
		if (!(file instanceof File)) throw new HttpError(400, 'Feltet «file» mangler.');
		const photo = await ingest({
			albumId: existing.album_id,
			replaceId: existing.id,
			file,
			title: optionalString(form, 'title'),
			caption: optionalString(form, 'caption'),
			keywords: keywordsFrom(form)
		});
		return json({ id: photo.id, version: photo.version, url: `${event.url.origin}/i/${photo.id}` });
	});
