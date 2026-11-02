import { json } from '@sveltejs/kit';
import { api, keywordsFrom, optionalString, readForm, requireAdmin } from '$lib/server/http';
import { ingest } from '$lib/server/photos';
import { HttpError } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Last opp et bilde til et album (fra nettsiden eller Lightroom). */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const form = await readForm(event.request);
		const file = form.get('file');
		if (!(file instanceof File)) throw new HttpError(400, 'Feltet «file» mangler.');
		const photo = await ingest({
			albumId: event.params.id,
			file,
			title: optionalString(form, 'title'),
			caption: optionalString(form, 'caption'),
			keywords: keywordsFrom(form)
		});
		return json({ id: photo.id, version: photo.version, url: `${event.url.origin}/i/${photo.id}` }, { status: 201 });
	});
