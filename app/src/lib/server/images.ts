import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';

sharp.cache(false);

/** Webversjoner, angitt som lengste side i piksler. Navnet brukes i URL-en. */
export const SIZES = [
	{ name: 's', edge: 480 },
	{ name: 'm', edge: 1024 },
	{ name: 'l', edge: 2048 },
	{ name: 'x', edge: 3200 }
] as const;
export const OG_EDGE = 1200;

export interface SizeInfo {
	name: string;
	w: number;
	h: number;
}

export interface ExifSummary {
	make?: string;
	model?: string;
	lens?: string;
	focal?: number;
	aperture?: number;
	shutter?: number;
	iso?: number;
}

export interface Processed {
	mime: string;
	ext: string;
	width: number;
	height: number;
	sizes: SizeInfo[];
	color: string | null;
	exif: ExifSummary;
	embedded: { title: string; caption: string; keywords: string[]; takenAt: number | null };
}

export class UnsupportedImageError extends Error {}

const FORMATS: Record<string, { mime: string; ext: string }> = {
	jpeg: { mime: 'image/jpeg', ext: '.jpg' },
	png: { mime: 'image/png', ext: '.png' },
	webp: { mime: 'image/webp', ext: '.webp' },
	tiff: { mime: 'image/tiff', ext: '.tif' },
	avif: { mime: 'image/avif', ext: '.avif' }
};

const INPUT = { failOn: 'none' as const, limitInputPixels: 500_000_000 };

/**
 * Leser et opplastet bilde, lager webversjoner i `outDir` og henter ut metadata.
 * Originalen røres ikke.
 */
export async function processImage(src: string, outDir: string): Promise<Processed> {
	let meta: sharp.Metadata;
	try {
		meta = await sharp(src, INPUT).metadata();
	} catch {
		throw new UnsupportedImageError('Fila er ikke et bilde som kan leses.');
	}
	let format = meta.format as string;
	if (format === 'heif') {
		if (meta.compression !== 'av1') throw new UnsupportedImageError('HEIC støttes ikke – eksporter som JPEG.');
		format = 'avif';
	}
	const kind = FORMATS[format];
	if (!kind) throw new UnsupportedImageError(`Formatet «${format}» støttes ikke. Bruk JPEG, PNG, WebP, TIFF eller AVIF.`);
	if (!meta.width || !meta.height) throw new UnsupportedImageError('Bildet mangler dimensjoner.');

	const rotated = (meta.orientation ?? 1) >= 5;
	const width = rotated ? meta.height : meta.width;
	const height = rotated ? meta.width : meta.height;
	const longEdge = Math.max(width, height);

	// Hvilke størrelser trengs? Aldri forstørr – største versjon blir maks originalstørrelsen.
	const targets: { name: string; edge: number }[] = [];
	for (const s of SIZES) {
		if (s.edge >= longEdge) {
			targets.push({ name: s.name, edge: longEdge });
			break;
		}
		targets.push({ ...s });
	}
	const largest = targets[targets.length - 1].edge;

	// Dekod originalen én gang til et rått sRGB-mellomformat, og lag alle størrelser fra det.
	const { data, info } = await sharp(src, INPUT)
		.rotate()
		.resize(largest, largest, { fit: 'inside', withoutEnlargement: true })
		.toColourspace('srgb')
		.raw({ depth: 'uchar' })
		.toBuffer({ resolveWithObject: true });
	const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };

	await fsp.mkdir(outDir, { recursive: true });
	const sizes: SizeInfo[] = [];
	for (const t of targets) {
		const out = await sharp(data, raw)
			.resize(t.edge, t.edge, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 82, effort: 4, smartSubsample: true })
			.toFile(path.join(outDir, `${t.name}.webp`));
		sizes.push({ name: t.name, w: out.width, h: out.height });
	}
	await sharp(data, raw)
		.resize(OG_EDGE, OG_EDGE, { fit: 'inside', withoutEnlargement: true })
		.flatten({ background: '#111111' })
		.jpeg({ quality: 82, mozjpeg: true })
		.toFile(path.join(outDir, 'og.jpg'));

	let color: string | null = null;
	try {
		const stats = await sharp(data, raw).resize(64, 64, { fit: 'inside' }).stats();
		const { r, g, b } = stats.dominant;
		color = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
	} catch {
		// ikke viktig
	}

	const { exif, embedded } = await readMetadata(src);
	return { mime: kind.mime, ext: kind.ext, width, height, sizes, color, exif, embedded };
}

// ---------------------------------------------------------------------------

type Any = Record<string, unknown>;

function text(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value);
	if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
	if (typeof value === 'object') {
		const v = value as Any;
		if ('value' in v) return text(v.value);
		const first = Object.values(v)[0];
		return text(first);
	}
	return '';
}

function list(value: unknown): string[] {
	if (value == null) return [];
	const arr = Array.isArray(value) ? value : [value];
	return arr
		.flatMap((v) => (typeof v === 'string' ? v.split(/[;,]/) : [text(v)]))
		.map((s) => s.trim())
		.filter(Boolean);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * EXIF-dato («2026:10:07 14:30:00») tolkes som veggklokke og lagres som om det var UTC,
 * så den vises likt uansett hvilken tidssone serveren står i.
 */
export function parseExifDate(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
	if (!m) return null;
	const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
	return Number.isFinite(t) && +m[1] > 1900 ? t : null;
}

async function readMetadata(src: string): Promise<{ exif: ExifSummary; embedded: Processed['embedded'] }> {
	let x: Any = {};
	try {
		x =
			((await exifr.parse(src, {
				tiff: true,
				exif: true,
				gps: false,
				xmp: true,
				iptc: true,
				icc: false,
				reviveValues: false,
				translateValues: false,
				mergeOutput: true
			})) as Any) ?? {};
	} catch {
		x = {};
	}
	const exif: ExifSummary = {
		make: text(x.Make) || undefined,
		model: text(x.Model) || undefined,
		lens: text(x.LensModel) || text(x.Lens) || undefined,
		focal: num(x.FocalLength),
		aperture: num(x.FNumber),
		shutter: num(x.ExposureTime),
		iso: num(x.ISO) ?? num(Array.isArray(x.ISO) ? x.ISO[0] : undefined)
	};
	const embedded = {
		title: text(x.title) || text(x.ObjectName) || text(x.Headline),
		caption: text(x.description) || text(x.Caption) || text(x.ImageDescription),
		keywords: [...new Set([...list(x.subject), ...list(x.Keywords)])],
		takenAt: parseExifDate(x.DateTimeOriginal) ?? parseExifDate(x.CreateDate) ?? parseExifDate(x.DateCreated)
	};
	return { exif, embedded };
}
