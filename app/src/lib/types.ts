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
