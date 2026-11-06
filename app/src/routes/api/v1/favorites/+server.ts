import { json } from '@sveltejs/kit';
import { favoriteCount, isFavorite, setFavorite, submission } from '$lib/server/guests';
import { api, readJson } from '$lib/server/http';
import { getPhoto } from '$lib/server/photos';
import { canFavorite, HttpError } from '$lib/server/tree';
import { albumOf } from '$lib/server/views';
import type { RequestHandler } from './$types';

/**
 * Hjertet på et bilde: { photo, on }. Bare for gjester i album som er delt med dem.
 * Når valget er sendt, er det låst. Har albumet «velg N bilder», kan man ikke velge flere enn N.
 */
export const POST: RequestHandler = ({ request, locals }) =>
	api(async () => {
		if (!locals.user) throw new HttpError(401, 'Ikke innlogget');
		const body = await readJson<{ photo?: unknown; on?: unknown }>(request);
		const photo = typeof body.photo === 'string' ? getPhoto(body.photo) : null;
		const album = photo ? albumOf(photo) : null;
		if (!photo || !album || !canFavorite(album, locals.user)) throw new HttpError(404, 'Finner ikke bildet');
		const on = body.on === true;
		if (submission(locals.user.id, album.id)?.lockedAt) {
			throw new HttpError(423, 'Valget er sendt og låst. Ta kontakt med fotografen hvis du vil endre det.');
		}
		if (on && album.pick_count && !isFavorite(locals.user.id, photo.id)) {
			const n = favoriteCount(locals.user.id, album.id);
			if (n >= album.pick_count) {
				throw new HttpError(409, `Du har valgt ${n} av ${album.pick_count}. Fjern et bilde før du velger et nytt.`);
			}
		}
		setFavorite(locals.user.id, photo.id, on);
		return json({ ok: true, on, count: favoriteCount(locals.user.id, album.id) });
	});
