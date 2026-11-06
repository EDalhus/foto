import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config';
import { all, one, run, tx } from './db';
import { newId, now } from './ids';
import { parseExifDate, processFrame, processImage, UnsupportedImageError, type ExifSummary, type SizeInfo } from './images';
import { albumIdsUnder, HttpError, invalidate } from './tree';
import { containerType, extractFrame, looksLikeVideo, probe, UnsupportedVideoError, type VideoInfo } from './video';
import { cancelVideo, kickVideo, kickWorker } from './worker';

export interface PhotoRow {
	id: string;
	album_id: string;
	sort_index: number;
	version: number;
	filename: string;
	mime: string;
	bytes: number;
	sha256: string;
	width: number;
	height: number;
	title: string;
	caption: string;
	keywords: string;
	taken_at: number | null;
	exif: string;
	color: string | null;
	sizes: string;
	original_key: string;
	original_state: 'pending' | 'stored';
	original_error: string | null;
	original_attempts: number;
	created_at: number;
	updated_at: number;
	kind: 'photo' | 'video';
	/** Video: lengde i sekunder. */
	duration: number | null;
	/** Video: VideoInfo som JSON. */
	video: string | null;
	/** Video: avspillingsversjonen (video.mp4) – lages i bakgrunnen. */
	video_state: 'pending' | 'ready' | 'failed' | null;
	video_error: string | null;
	video_attempts: number;
}

export interface Photo extends Omit<PhotoRow, 'keywords' | 'exif' | 'sizes' | 'video'> {
	keywords: string[];
	exif: ExifSummary;
	sizes: SizeInfo[];
	video: VideoInfo | null;
}

export function parsePhoto(row: PhotoRow): Photo {
	return {
		...row,
		keywords: safeJson(row.keywords, []),
		exif: safeJson(row.exif, {}),
		sizes: safeJson(row.sizes, []),
		video: row.video ? safeJson<VideoInfo | null>(row.video, null) : null
	};
}

function safeJson<T>(s: string, fallback: T): T {
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

export function getPhoto(id: string): Photo | null {
	const row = one<PhotoRow>(`SELECT * FROM photos WHERE id = ?`, id);
	return row ? parsePhoto(row) : null;
}

export function listPhotos(albumId: string): Photo[] {
	return all<PhotoRow>(`SELECT * FROM photos WHERE album_id = ? ORDER BY sort_index, created_at, id`, albumId).map(
		parsePhoto
	);
}

export function getPhotosByIds(ids: string[]): Photo[] {
	if (!ids.length) return [];
	return all<PhotoRow>(`SELECT * FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map(parsePhoto);
}

/** Filnavnet originalen lastes ned med: opprinnelig navn, med riktig filendelse. */
export function downloadName(p: Pick<PhotoRow, 'filename' | 'original_key'>): string {
	const ext = path.extname(p.original_key);
	const own = path.extname(p.filename);
	const lower = own.toLowerCase();
	const same = lower === ext || (ext === '.jpg' && lower === '.jpeg') || (ext === '.tif' && lower === '.tiff');
	return same ? p.filename : `${path.basename(p.filename, own) || 'bilde'}${ext}`;
}

// --- Filstier ---

export const derivedDir = (id: string, version: number) => path.join(config.derivedDir, id, `v${version}`);
export const pendingFile = (p: Pick<PhotoRow, 'id' | 'version' | 'original_key'>) =>
	path.join(config.pendingDir, `${p.id}_v${p.version}${path.extname(p.original_key)}`);

/** Filnavn som er trygt i en lagringsnøkkel (originalnavnet beholdes i databasen). */
function safeFileName(name: string): string {
	const ext = path.extname(name);
	const base = path
		.basename(name, ext)
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/æ/gi, 'ae')
		.replace(/ø/gi, 'o')
		.replace(/å/gi, 'a')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(0, 80);
	return base || 'bilde';
}

function cleanText(value: unknown, max: number): string {
	return String(value ?? '')
		.trim()
		.slice(0, max);
}

// --- Opplasting ---

export interface IngestInput {
	albumId: string;
	/** Fila fra et skjema … */
	file?: File;
	/** … eller en fil som allerede ligger på disk (opplasting i biter). Den flyttes inn og er borte etterpå. */
	path?: string;
	/** Filnavnet når `path` brukes. */
	filename?: string;
	/** undefined = bruk det som ligger i bildefila (XMP/IPTC). */
	title?: string;
	caption?: string;
	keywords?: string[];
	/** Opptakstid fra Lightroom (veggklokke, «2026-09-14T10:22:31») – brukes for video, der fila sjelden har den. */
	takenAt?: string;
	/** Erstatt et eksisterende bilde (ny versjon, samme ID og plass i albumet). */
	replaceId?: string;
}

/** Det som er felles for bilder og video etter at fila er lest. */
interface Prepared {
	kind: 'photo' | 'video';
	mime: string;
	ext: string;
	width: number;
	height: number;
	sizes: SizeInfo[];
	color: string | null;
	exif: ExifSummary;
	embedded: { title: string; caption: string; keywords: string[]; takenAt: number | null };
	duration: number | null;
	video: VideoInfo | null;
}

/** Veggklokke for en video: Lightroom sin opptakstid, ellers fila sin (UTC gjøres om til norsk tid). */
function videoTakenAt(given: string | undefined, info: VideoInfo): number | null {
	const fromLr = parseExifDate(given);
	if (fromLr) return fromLr;
	const c = info.createdAt;
	if (!c) return null;
	if (!/Z$|[+-]\d{2}:?\d{2}$/.test(c)) return parseExifDate(c);
	const t = Date.parse(c);
	if (!Number.isFinite(t) || t < Date.UTC(1990, 0, 1)) return null;
	const parts = new Intl.DateTimeFormat('sv-SE', {
		timeZone: 'Europe/Oslo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	}).format(t);
	return parseExifDate(parts.replace(' ', 'T'));
}

async function prepare(file: string, staging: string, filename: string, takenAt: string | undefined, bytes: number): Promise<Prepared> {
	if (await looksLikeVideo(file)) {
		let info: VideoInfo;
		const frame = `${staging}.frame.png`;
		try {
			info = await probe(file);
			await extractFrame(file, info, frame);
			const d = await processFrame(frame, staging);
			const { mime, ext } = containerType(info, filename);
			return {
				kind: 'video',
				mime,
				ext,
				width: d.width,
				height: d.height,
				sizes: d.sizes,
				color: d.color,
				exif: { make: info.make, model: info.model },
				embedded: { title: '', caption: '', keywords: [], takenAt: videoTakenAt(takenAt, info) },
				duration: info.duration,
				video: info
			};
		} catch (err) {
			if (err instanceof UnsupportedVideoError || err instanceof UnsupportedImageError) throw new HttpError(415, err.message);
			throw err;
		} finally {
			await fsp.rm(frame, { force: true }).catch(() => {});
		}
	}
	if (bytes > config.maxUploadBytes) throw new HttpError(413, 'Bildet er for stort.');
	try {
		const p = await processImage(file, staging);
		return { ...p, kind: 'photo', duration: null, video: null };
	} catch (err) {
		if (err instanceof UnsupportedImageError) throw new HttpError(415, err.message);
		throw err;
	}
}

/** Sjekksum og størrelse for en fil som allerede ligger på disk. */
async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
	const hash = createHash('sha256');
	let bytes = 0;
	const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		hash.update(chunk);
		bytes += chunk.length;
	}
	return { sha256: hash.digest('hex'), bytes };
}

/** Lagrer en opplasting: lager webversjoner med en gang, originalen sendes til lagringen i bakgrunnen. Video får også en avspillingsversjon i bakgrunnen. */
export async function ingest(input: IngestInput): Promise<Photo> {
	const album = one<{ id: string; type: string }>(`SELECT id, type FROM nodes WHERE id = ?`, input.albumId);
	if (!album) throw new HttpError(404, 'Albumet finnes ikke.');
	if (album.type !== 'album') throw new HttpError(400, 'Bilder kan bare lastes opp til album.');
	const existing = input.replaceId ? getPhoto(input.replaceId) : null;
	if (input.replaceId && !existing) throw new HttpError(404, 'Bildet som skulle erstattes finnes ikke.');
	if (!input.path && (!input.file || typeof input.file.stream !== 'function')) throw new HttpError(400, 'Fil mangler.');
	if (input.file && input.file.size > config.maxUploadBytes) throw new HttpError(413, 'Fila er for stor.');

	await Promise.all([config.tmpDir, config.pendingDir, config.derivedDir].map((d) => fsp.mkdir(d, { recursive: true })));
	// Fra skjema skrives fila til en egen midlertidig fil; fra opplasting i biter brukes fila som allerede ligger der.
	const tmpFile = input.path ?? path.join(config.tmpDir, randomUUID());
	const staging = path.join(config.tmpDir, `${randomUUID()}.d`);
	let moved = false;
	try {
		// 1. Skriv fila til disk og regn ut sjekksum underveis.
		let sha256: string;
		let bytes = 0;
		if (input.file) {
			const hash = createHash('sha256');
			const source = Readable.fromWeb(input.file.stream() as never);
			source.on('data', (chunk: Buffer) => {
				hash.update(chunk);
				bytes += chunk.length;
			});
			await pipeline(source, fs.createWriteStream(tmpFile));
			sha256 = hash.digest('hex');
		} else {
			({ sha256, bytes } = await hashFile(tmpFile));
		}
		if (bytes === 0) throw new HttpError(400, 'Fila er tom.');
		const rawName = input.file?.name || input.filename || '';

		// 2. Webversjoner + metadata (for video: stillbilde, lengde og mål).
		const processed = await prepare(tmpFile, staging, rawName, input.takenAt, bytes);

		const id = existing?.id ?? newId();
		const version = existing ? existing.version + 1 : 1;
		const filename = cleanText(rawName || `${processed.kind === 'video' ? 'video' : 'bilde'}${processed.ext}`, 255);
		const d = new Date();
		const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
		const key = `${month}/${id}_v${version}_${safeFileName(filename)}${processed.ext}`;

		const title = input.title !== undefined ? cleanText(input.title, 500) : processed.embedded.title.slice(0, 500);
		const caption =
			input.caption !== undefined ? cleanText(input.caption, 5000) : processed.embedded.caption.slice(0, 5000);
		const keywords = (input.keywords ?? processed.embedded.keywords).map((k) => cleanText(k, 100)).filter(Boolean);

		// 3. Flytt filene på plass før databasen oppdateres.
		const pending = pendingFile({ id, version, original_key: key });
		await fsp.rename(tmpFile, pending);
		moved = true;
		const finalDerived = derivedDir(id, version);
		await fsp.rm(finalDerived, { recursive: true, force: true });
		await fsp.mkdir(path.dirname(finalDerived), { recursive: true });
		await fsp.rename(staging, finalDerived);

		const t = now();
		const isVideo = processed.kind === 'video';
		const values = {
			version,
			filename,
			mime: processed.mime,
			bytes,
			sha256,
			width: processed.width,
			height: processed.height,
			title,
			caption,
			keywords: JSON.stringify(keywords),
			taken_at: processed.embedded.takenAt,
			exif: JSON.stringify(processed.exif),
			color: processed.color,
			sizes: JSON.stringify(processed.sizes),
			original_key: key,
			kind: processed.kind,
			duration: processed.duration,
			video: processed.video ? JSON.stringify(processed.video) : null,
			video_state: isVideo ? 'pending' : null
		};

		try {
			tx(() => {
				if (existing) {
					const cur = one<PhotoRow>(`SELECT * FROM photos WHERE id = ?`, existing.id);
					if (!cur) throw new HttpError(404, 'Bildet ble slettet under opplastingen.');
					run(
						`UPDATE photos SET version = ?, filename = ?, mime = ?, bytes = ?, sha256 = ?, width = ?, height = ?, title = ?, caption = ?,
						 keywords = ?, taken_at = ?, exif = ?, color = ?, sizes = ?, original_key = ?, original_state = 'pending',
						 original_error = NULL, original_attempts = 0, kind = ?, duration = ?, video = ?, video_state = ?, video_error = NULL,
						 video_attempts = 0, updated_at = ? WHERE id = ?`,
						values.version, values.filename, values.mime, values.bytes, values.sha256, values.width, values.height,
						values.title, values.caption, values.keywords, values.taken_at, values.exif, values.color, values.sizes,
						values.original_key, values.kind, values.duration, values.video, values.video_state, t, existing.id
					);
					forgetOriginal(cur);
				} else {
					const max = one<{ m: number | null }>(`SELECT max(sort_index) AS m FROM photos WHERE album_id = ?`, album.id);
					run(
						`INSERT INTO photos (id, album_id, sort_index, version, filename, mime, bytes, sha256, width, height, title, caption,
						 keywords, taken_at, exif, color, sizes, original_key, original_state, kind, duration, video, video_state, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
						id, album.id, (max?.m ?? -1) + 1, values.version, values.filename, values.mime, values.bytes, values.sha256,
						values.width, values.height, values.title, values.caption, values.keywords, values.taken_at, values.exif,
						values.color, values.sizes, values.original_key, values.kind, values.duration, values.video, values.video_state, t, t
					);
				}
				run(`UPDATE nodes SET updated_at = ? WHERE id = ?`, t, album.id);
			});
		} catch (err) {
			await fsp.rm(pending, { force: true });
			await fsp.rm(finalDerived, { recursive: true, force: true });
			throw err;
		}
		if (existing) {
			cancelVideo(existing.id);
			await fsp.rm(derivedDir(existing.id, existing.version), { recursive: true, force: true });
		}
		invalidate();
		kickWorker();
		if (isVideo) kickVideo();
		return getPhoto(id)!;
	} finally {
		// En fil fra opplasting i biter ryddes av den som eier den (den kan prøves på nytt).
		if (!input.path && !moved) await fsp.rm(tmpFile, { force: true }).catch(() => {});
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Sørger for at den gamle originalen fjernes: lokal ventefil slettes med en gang,
 * en lagret original legges i slettekøen (UNAS kan være utilgjengelig akkurat nå).
 */
function forgetOriginal(row: Pick<PhotoRow, 'id' | 'version' | 'original_key' | 'original_state'>) {
	fs.rmSync(pendingFile(row), { force: true });
	// Selv om originalen fortsatt står som «pending» kan den være midt i en opplasting – slett den uansett.
	run(`INSERT OR IGNORE INTO store_deletes (key, created_at) VALUES (?, ?)`, row.original_key, now());
}

// --- Sletting ---

export async function deletePhotos(ids: string[]): Promise<string[]> {
	const rows = ids.length
		? all<PhotoRow>(`SELECT * FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
		: [];
	if (!rows.length) return [];
	tx(() => {
		for (const r of rows) {
			forgetOriginal(r);
			run(`DELETE FROM photos WHERE id = ?`, r.id);
			run(`UPDATE nodes SET cover_photo_id = NULL WHERE cover_photo_id = ?`, r.id);
		}
	});
	for (const r of rows) {
		cancelVideo(r.id);
		await fsp.rm(path.join(config.derivedDir, r.id), { recursive: true, force: true });
	}
	invalidate();
	kickWorker();
	return rows.map((r) => r.id);
}

/** Sletter en mappe/et album med alt innhold, inkludert bildefilene. */
export async function deleteNode(id: string): Promise<void> {
	const exists = one(`SELECT 1 FROM nodes WHERE id = ?`, id);
	if (!exists) return;
	const albumIds = albumIdsUnder(id);
	if (albumIds.length) {
		const photoIds = all<{ id: string }>(
			`SELECT id FROM photos WHERE album_id IN (${albumIds.map(() => '?').join(',')})`,
			...albumIds
		).map((r) => r.id);
		await deletePhotos(photoIds);
	}
	// Mapper peker kanskje på et forsidebilde i et album som nå forsvinner – deletePhotos har nullet dem ut.
	run(`DELETE FROM nodes WHERE id = ?`, id);
	invalidate();
}

// --- Rekkefølge og redigering ---

/** Setter rekkefølgen i et album. Bilder som ikke er med i lista havner bakerst i nåværende rekkefølge. */
export function reorder(albumId: string, orderedIds: string[]): void {
	tx(() => {
		const current = listPhotos(albumId).map((p) => p.id);
		const set = new Set(current);
		const seen = new Set<string>();
		const order = orderedIds.filter((id) => set.has(id) && !seen.has(id) && seen.add(id));
		for (const id of current) if (!seen.has(id)) order.push(id);
		order.forEach((id, i) => run(`UPDATE photos SET sort_index = ? WHERE id = ?`, i, id));
	});
	invalidate();
}

export function sortByTaken(albumId: string): void {
	const ids = all<{ id: string }>(
		`SELECT id FROM photos WHERE album_id = ? ORDER BY taken_at IS NULL, taken_at, created_at, id`,
		albumId
	).map((r) => r.id);
	reorder(albumId, ids);
}

export function updatePhoto(id: string, patch: { title?: string; caption?: string }): void {
	const p = getPhoto(id);
	if (!p) throw new HttpError(404, 'Bildet finnes ikke.');
	run(
		`UPDATE photos SET title = ?, caption = ?, updated_at = ? WHERE id = ?`,
		patch.title !== undefined ? cleanText(patch.title, 500) : p.title,
		patch.caption !== undefined ? cleanText(patch.caption, 5000) : p.caption,
		now(),
		id
	);
	invalidate();
}

export function movePhotos(ids: string[], albumId: string): void {
	const album = one<{ type: string }>(`SELECT type FROM nodes WHERE id = ?`, albumId);
	if (!album || album.type !== 'album') throw new HttpError(400, 'Velg et album å flytte til.');
	tx(() => {
		let next = (one<{ m: number | null }>(`SELECT max(sort_index) AS m FROM photos WHERE album_id = ?`, albumId)?.m ?? -1) + 1;
		for (const id of ids) {
			const r = run(`UPDATE photos SET album_id = ?, sort_index = ? WHERE id = ? AND album_id != ?`, albumId, next, id, albumId);
			if (r.changes) {
				next++;
				run(`UPDATE nodes SET cover_photo_id = NULL WHERE cover_photo_id = ? AND id != ?`, id, albumId);
			}
		}
	});
	invalidate();
}

export function pendingCount(): number {
	return one<{ n: number }>(`SELECT count(*) AS n FROM photos WHERE original_state = 'pending'`)?.n ?? 0;
}
