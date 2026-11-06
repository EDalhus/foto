import { error, redirect } from '@sveltejs/kit';
import { getPhoto, listPhotos } from '$lib/server/photos';
import { favoriteIds, submission } from '$lib/server/guests';
import { canFavorite, canView, pathOf } from '$lib/server/tree';
import { albumOf, crumbs, photoView } from '$lib/server/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, url }) => {
	const photo = getPhoto(params.id);
	const album = photo ? albumOf(photo) : null;
	if (!photo || !album) error(404, 'Finner ikke bildet');
	if (!canView(album, locals.user)) {
		if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
		error(404, 'Finner ikke bildet');
	}
	const photos = listPhotos(album.id).map((p) => photoView(p, album, locals.user));
	return {
		photoId: photo.id,
		photos,
		album: { id: album.id, name: album.name, path: pathOf(album), isPrivate: album.effectivePrivate },
		crumbs: crumbs(album, locals.user),
		favorites: canFavorite(album, locals.user) ? favoriteIds(locals.user!.id, album.id) : null,
		favoritesLocked: canFavorite(album, locals.user) ? !!submission(locals.user!.id, album.id)?.lockedAt : false,
		pickTarget: album.pick_count
	};
};
