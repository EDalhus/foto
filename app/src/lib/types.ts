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
	kind: 'photo' | 'video';
	/** Video: lengde i sekunder. */
	duration: number | null;
	/** Video: avspillingsversjonen, eller null mens den lages (eller hvis den feilet). */
	video: string | null;
	videoState: 'pending' | 'ready' | 'failed' | null;
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
	/** Kategorien kortet står i (bare når mappa viser kategorier). */
	category?: { name: string; color: string | null } | null;
}

/** Hvordan kategoriene i en mappe vises for kundene. */
export type CategoryStyle = 'sections' | 'tags' | 'filter' | 'boxes' | 'rows' | 'stacks';

/** En kategori med kortene sine. id null = det som ikke har kategori («Andre»). */
export interface CardGroup {
	id: string | null;
	name: string;
	slug: string;
	description: string;
	color: string | null;
	cards: CardView[];
}

export interface Grouping {
	style: CategoryStyle;
	groups: CardGroup[];
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
	/** Når gjestene fikk påminnelse om at tilgangen går ut. */
	remindedAt: number | null;
	shared: boolean;
	direct: boolean;
	via: string | null;
	members: { id: string; name: string; email: string; lastLogin: number | null }[];
}
