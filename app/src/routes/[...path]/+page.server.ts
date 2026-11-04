import { error, fail, redirect } from '@sveltejs/kit';
import { favoriteIds, linkSendAllowed, markSubmitted, submittedAt } from '$lib/server/guests';
import { noticeMail, notifyAdmin } from '$lib/server/mail';
import { getPhotosByIds, listPhotos } from '$lib/server/photos';
import { canDownload, canFavorite, canView, isAdmin, pathOf, resolvePath, visibleChildren } from '$lib/server/tree';
import { cardViews, crumbs, photoView } from '$lib/server/views';
import type { SessionUser } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function findNode(path: string, user: SessionUser | null, pathname: string) {
	const node = resolvePath(path.split('/').filter(Boolean));
	if (!node || !canView(node, user)) {
		// Private album skal se ut som om de ikke finnes – men gi innloggingsmulighet.
		if (node && !user) redirect(303, `/login?next=${encodeURIComponent(pathname)}`);
		error(404, 'Finner ikke siden');
	}
	return node;
}

export const load: PageServerLoad = ({ params, locals, url }) => {
	const node = findNode(params.path, locals.user, url.pathname);
	const canonical = pathOf(node);
	if (decodeURIComponent(url.pathname).replace(/\/+$/, '') !== canonical) redirect(301, canonical);

	const base = {
		node: {
			id: node.id,
			type: node.type,
			name: node.name,
			description: node.description,
			path: canonical,
			isPrivate: node.effectivePrivate,
			photoCount: node.photoCount,
			albumCount: node.albumCount,
			latest: node.latest
		},
		crumbs: crumbs(node, locals.user),
		isAdmin: isAdmin(locals.user)
	};

	if (node.type === 'folder') {
		return { ...base, cards: cardViews(visibleChildren(node, locals.user), locals.user), photos: [], downloadAll: null, favorites: null };
	}
	const photos = listPhotos(node.id).map((p) => photoView(p, node, locals.user));
	const taken = photos.map((p) => p.takenAt).filter((t): t is number => !!t);
	const fav = canFavorite(node, locals.user)
		? { ids: favoriteIds(locals.user!.id, node.id), submittedAt: submittedAt(locals.user!.id, node.id) }
		: null;
	return {
		...base,
		cards: [],
		photos,
		range: taken.length ? { from: Math.min(...taken), to: Math.max(...taken) } : null,
		downloadAll: canDownload(node, locals.user) && photos.length ? `/download/album/${node.id}` : null,
		favorites: fav
	};
};

export const actions: Actions = {
	/** «Send valget»: gir beskjed til fotografen om hvilke bilder gjesten har valgt. */
	sendFavorites: ({ params, locals, url }) => {
		const node = findNode(params.path, locals.user, url.pathname);
		const user = locals.user;
		if (!user || !canFavorite(node, user)) return fail(403, { error: 'Du kan ikke velge bilder i dette albumet.' });
		const ids = favoriteIds(user.id, node.id);
		if (!ids.length) return fail(400, { error: 'Du har ikke valgt noen bilder ennå. Trykk på hjertet på bildene du vil ha.' });
		if (!linkSendAllowed(`fav:${user.id}:${node.id}`, 5)) return fail(429, { error: 'Du har sendt mange ganger nå. Vent litt og prøv igjen.' });
		markSubmitted(user.id, node.id, ids.length);
		const who = user.name ? `${user.name} (${user.email})` : user.email;
		const names = getPhotosByIds(ids)
			.sort((a, b) => a.sort_index - b.sort_index)
			.map((p) => p.filename);
		notifyAdmin((to) =>
			noticeMail({
				to,
				subject: `${user.name || user.email} har valgt ${ids.length} ${ids.length === 1 ? 'bilde' : 'bilder'} i «${node.name}»`,
				heading: `${ids.length} ${ids.length === 1 ? 'bilde' : 'bilder'} valgt i «${node.name}»`,
				lines: [`${who} har sendt deg valget sitt.`, 'Filnavnene (lim dem inn i Lightroom-filteret «Filnavn inneholder» for å finne bildene):'],
				list: names.map((n) => n.replace(/\.[^.]+$/, '')).join(' '),
				url: `${url.origin}/admin/node/${node.id}#favoritter`,
				button: 'Se valget'
			})
		);
		return { sent: ids.length };
	}
};
