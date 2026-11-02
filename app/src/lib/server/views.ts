import type { CardView, Crumb, ImageView, PhotoView } from '$lib/types';
import type { SessionUser } from './auth';
import { getPhotosByIds, type Photo } from './photos';
import { ancestors, canView, getTree, isAdmin, pathOf, type TreeNode } from './tree';

export function mediaUrl(p: Pick<Photo, 'id' | 'version'>, file: string) {
	return `/media/${p.id}/${p.version}/${file}`;
}

export function imageView(p: Photo): ImageView {
	const sizes = p.sizes.length ? p.sizes : [{ name: 's', w: p.width, h: p.height }];
	const mid = sizes.find((s) => s.name === 'm') ?? sizes[sizes.length - 1];
	return {
		id: p.id,
		w: p.width,
		h: p.height,
		color: p.color,
		src: mediaUrl(p, `${mid.name}.webp`),
		srcset: sizes.map((s) => `${mediaUrl(p, `${s.name}.webp`)} ${s.w}w`).join(', ')
	};
}

export function photoView(p: Photo, album: TreeNode, user: SessionUser | null): PhotoView {
	return {
		...imageView(p),
		title: p.title,
		caption: p.caption,
		filename: p.filename,
		takenAt: p.taken_at,
		exif: p.exif,
		download: album.allow_download || isAdmin(user) ? `/download/photo/${p.id}` : null,
		og: mediaUrl(p, 'og.jpg')
	};
}

/** Forsidebilde: valgt bilde, ellers første bilde – for mapper det første synlige albumets forside. */
function coverPhotoId(node: TreeNode, user: SessionUser | null, depth = 0): string | null {
	if (node.type === 'album') return node.cover_photo_id ?? node.firstPhotoId;
	if (node.cover_photo_id) return node.cover_photo_id;
	if (depth > 10) return null;
	for (const c of node.children) {
		if (!canView(c, user)) continue;
		const id = coverPhotoId(c, user, depth + 1);
		if (id) return id;
	}
	return null;
}

export function cardViews(nodes: TreeNode[], user: SessionUser | null): CardView[] {
	const coverIds = new Map(nodes.map((n) => [n.id, coverPhotoId(n, user)]));
	const photos = new Map(
		getPhotosByIds([...new Set([...coverIds.values()].filter((x): x is string => !!x))]).map((p) => [p.id, p])
	);
	return nodes.map((n) => {
		let cover = photos.get(coverIds.get(n.id) ?? '');
		// Et valgt forsidebilde kan ligge i et privat album – vis det aldri til noen som ikke har tilgang.
		const coverAlbum = cover ? getTree().byId.get(cover.album_id) : undefined;
		if (cover && (!coverAlbum || !canView(coverAlbum, user))) cover = undefined;
		return {
			id: n.id,
			type: n.type,
			name: n.name,
			path: pathOf(n),
			photoCount: n.photoCount,
			albumCount: n.albumCount,
			latest: n.latest,
			isPrivate: n.effectivePrivate,
			cover: cover ? imageView(cover) : null
		};
	});
}

export function crumbs(node: TreeNode): Crumb[] {
	return ancestors(node).map((a) => ({ name: a.name, path: pathOf(a) }));
}

export function albumOf(p: Photo): TreeNode | null {
	return getTree().byId.get(p.album_id) ?? null;
}
