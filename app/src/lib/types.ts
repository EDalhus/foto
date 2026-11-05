/** Datatyper som sendes fra server til nettleser. */

export interface ImageView {
	id: string;
	w: number;
	h: number;
	color: string | null;
	src: string;
	srcset: string;
}

export interface PhotoView extends ImageView {
	title: string;
	caption: string;
	filename: string;
	takenAt: number | null;
	exif: {
		make?: string;
		model?: string;
		lens?: string;
		focal?: number;
		aperture?: number;
		shutter?: number;
		iso?: number;
	};
	download: string | null;
	og: string;
}

export interface CardView {
	id: string;
	type: 'folder' | 'album';
	name: string;
	path: string;
	photoCount: number;
	albumCount: number;
	latest: number;
	isPrivate: boolean;
	cover: ImageView | null;
}

export interface Crumb {
	name: string;
	path: string;
}

/** Et treff i søkeboksen (⌘K). */
export interface SearchHit {
	id: string;
	kind: 'folder' | 'album' | 'photo';
	name: string;
	href: string;
	meta: string;
	isPrivate: boolean;
	thumb: { src: string; srcset: string; color: string | null } | null;
}

/** Hvem som ser en mappe eller et album (admin). */
export type AccessMode = 'public' | 'private' | 'client';

export interface GroupAccessView {
	id: string;
	name: string;
	kind: 'family' | 'client';
	download: 'album' | 'yes' | 'no';
	expiresDate: string;
	expired: boolean;
	shared: boolean;
	direct: boolean;
	via: string | null;
	members: { id: string; name: string; email: string; lastLogin: number | null }[];
}
