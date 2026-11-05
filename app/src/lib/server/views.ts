import type { CardView, Crumb, ImageView, PhotoView } from '$lib/types';
import type { SessionUser } from './auth';
import { getPhotosByIds, type Photo } from './photos';
import { ancestors, canDownload, canView, getTree, pathOf, type TreeNode } from './tree';
import { WATERMARKED, watermarkFor, wmName } from './watermark';

export function mediaUrl(p: Pick<Photo, 'id' | 'version'>, file: string) {
	return `/media/${p.id}/${p.version}/${file}`;
}

/** Filnavnet i URL-en – med vannmerke hvis `wm` er satt og størrelsen skal ha det. */
export const mediaFile = (file: string, wm: number | null = null) => (wm !== null && WATERMARKED.has(file) ? wmName(file, wm) : file);

/** `wm`: vannmerkeversjon (fra watermarkFor), eller null for bildene uten. */
export function imageView(p: Photo, wm: number | null = null): ImageView {
	const sizes = p.sizes.length ? p.sizes : [{ name: 's', w: p.width, h: p.height }];
	const mid = sizes.find((s) => s.name === 'm') ?? sizes[sizes.length - 1];
	return {
		id: p.id,
		w: p.width,
		h: p.height,
		color: p.color,
		src: mediaUrl(p, mediaFile(`${mid.name}.webp`, wm)),
		srcset: sizes.map((s) => `${mediaUrl(p, mediaFile(`${s.name}.webp`, wm))} ${s.w}w`).join(', ')
	};
}

export function photoView(p: Photo, album: TreeNode, user: SessionUser | null): PhotoView {
	const wm = watermarkFor(album, user);
	return {
		...imageView(p, wm),
		title: p.title,
		caption: p.caption,
		filename: p.filename,
		takenAt: p.taken_at,
		exif: p.exif,
		download: canDownload(album, user) ? `/download/photo/${p.id}` : null,
		og: mediaUrl(p, mediaFile('og.jpg', wm))
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

/** Forsidebildet slik brukeren ser det: valgt av deg, ellers automatisk. */
export function coverView(node: TreeNode, user: SessionUser | null): (ImageView & { photoId: string }) | null {
	const id = coverPhotoId(node, user);
	const p = id ? getPhotosByIds([id])[0] : undefined;
	const album = p ? getTree().byId.get(p.album_id) : undefined;
	if (!p || !album || !canView(album, user)) return null;
	return { ...imageView(p, watermarkFor(album, user)), photoId: p.id };
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
			cover: cover && coverAlbum ? imageView(cover, watermarkFor(coverAlbum, user)) : null
		};
	});
}

/** Brødsmuler. Mapper brukeren ikke har tilgang til (f.eks. en privat mappe over et delt album), vises ikke. */
export function crumbs(node: TreeNode, user: SessionUser | null = null): Crumb[] {
	return ancestors(node)
		.filter((a) => canView(a, user))
		.map((a) => ({ name: a.name, path: pathOf(a) }));
}

export function albumOf(p: Photo): TreeNode | null {
	return getTree().byId.get(p.album_id) ?? null;
}
