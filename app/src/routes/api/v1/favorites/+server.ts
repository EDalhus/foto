import { json } from '@sveltejs/kit';
import { setFavorite } from '$lib/server/guests';
import { api, readJson } from '$lib/server/http';
import { getPhoto } from '$lib/server/photos';
import { canFavorite, HttpError } from '$lib/server/tree';
import { albumOf } from '$lib/server/views';
import type { RequestHandler } from './$types';

/** Hjertet på et bilde: { photo, on }. Bare for gjester i album som er delt med dem. */
export const POST: RequestHandler = ({ request, locals }) =>
	api(async () => {
		if (!locals.user) throw new HttpError(401, 'Ikke innlogget');
		const body = await readJson<{ photo?: unknown; on?: unknown }>(request);
		const photo = typeof body.photo === 'string' ? getPhoto(body.photo) : null;
		const album = photo ? albumOf(photo) : null;
		if (!photo || !album || !canFavorite(album, locals.user)) throw new HttpError(404, 'Finner ikke bildet');
		setFavorite(locals.user.id, photo.id, body.on === true);
		return json({ ok: true, on: body.on === true });
	});
