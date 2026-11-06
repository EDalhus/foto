import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { config } from './config';
import { all, one, run } from './db';
import { newId, now } from './ids';
import { getPhoto, ingest, type Photo } from './photos';
import { HttpError } from './tree';

/**
 * Opplasting i biter, for store filer (video). Lightroom og nettleseren sender fila i biter på 32 MB,
 * så hver forespørsel holder seg godt under grensene i nginx og SvelteKit, og en nettfeil koster bare én bit.
 *
 *   POST /api/v1/uploads                 { albumId, filename, size, … }  → { id, chunkSize, received }
 *   PUT  /api/v1/uploads/:id?offset=N    (rå byte)                        → { received, size }
 *   POST /api/v1/uploads/:id/complete                                     → bildet/videoen
 *
 * En bit kan sendes på nytt (samme posisjon) uten skade. Fullføring kan også gjentas: svaret er det samme.
 */

export const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/** Største forespørsel serveren tar imot (BODY_SIZE_LIMIT i adapter-node, standard 512K). */
function bodyLimit(): number {
	const raw = String(env.BODY_SIZE_LIMIT ?? '512K').trim();
	if (raw === 'Infinity') return Infinity;
	const m = /^(\d+)([KMG]?)$/i.exec(raw);
	if (!m) return 512 * 1024;
	return Number(m[1]) * ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[m[2].toUpperCase()];
}

/** Bitstørrelsen klientene skal bruke: 32 MB, eller mindre hvis serveren ikke tar imot så store forespørsler. */
export function chunkSize(): number {
	return Math.max(64 * 1024, Math.min(CHUNK_BYTES, bodyLimit() - 16 * 1024));
}
/** Opplastinger som ikke har fått noe nytt på så lenge, ryddes bort. */
const STALE_MS = 6 * 3600_000;
/** Ledig plass som skal være igjen på disken etter opplastingen. */
const DISK_MARGIN = 1024 ** 3;

interface UploadRow {
	id: string;
	album_id: string;
	replace_id: string | null;
	filename: string;
	size: number;
	received: number;
	meta: string;
	photo_id: string | null;
	created_at: number;
	updated_at: number;
}

interface UploadMeta {
	title?: string;
	caption?: string;
	keywords?: string[];
	takenAt?: string;
}

/** 409 med hvor mye serveren har fått, så klienten kan fortsette derfra. */
export class UploadConflict extends HttpError {
	constructor(
		message: string,
		public received: number
	) {
		super(409, message);
	}
}

const partFile = (id: string) => path.join(config.tmpDir, `upload-${id}.part`);
const getRow = (id: string) => one<UploadRow>(`SELECT * FROM uploads WHERE id = ?`, id);
const gb = (n: number) => `${Math.round((n / 1024 ** 3) * 10) / 10} GB`.replace('.', ',');

const optText = (v: unknown) => (typeof v === 'string' ? v : undefined);

export interface StartInput {
	albumId?: unknown;
	filename?: unknown;
	size?: unknown;
	replaceId?: unknown;
	title?: unknown;
	caption?: unknown;
	keywords?: unknown;
	takenAt?: unknown;
}

export async function startUpload(input: StartInput): Promise<{ id: string; chunkSize: number; received: number }> {
	const albumId = String(input.albumId ?? '');
	const album = one<{ type: string }>(`SELECT type FROM nodes WHERE id = ?`, albumId);
	if (!album) throw new HttpError(404, 'Albumet finnes ikke.');
	if (album.type !== 'album') throw new HttpError(400, 'Bilder kan bare lastes opp til album.');
	const size = Number(input.size);
	if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Ugyldig filstørrelse.');
	if (size > config.maxLargeUploadBytes) throw new HttpError(413, `Fila er for stor (maks ${gb(config.maxLargeUploadBytes)}).`);
	const filename = String(input.filename ?? '').trim().slice(0, 255);
	if (!filename) throw new HttpError(400, 'Filnavn mangler.');
	const replaceId = typeof input.replaceId === 'string' && input.replaceId ? input.replaceId : null;
	if (replaceId && !one(`SELECT 1 FROM photos WHERE id = ?`, replaceId)) throw new HttpError(404, 'Bildet som skulle erstattes finnes ikke.');

	await fsp.mkdir(config.tmpDir, { recursive: true });
	const disk = await fsp.statfs(config.tmpDir).catch(() => null);
	if (disk && disk.bavail * disk.bsize - size < DISK_MARGIN) {
		throw new HttpError(507, 'Det er ikke nok ledig plass på serveren til denne fila.');
	}

	const meta: UploadMeta = {
		title: optText(input.title),
		caption: optText(input.caption),
		takenAt: optText(input.takenAt)
	};
	if (Array.isArray(input.keywords)) meta.keywords = input.keywords.map(String);
	else if (typeof input.keywords === 'string') meta.keywords = input.keywords.split(',').map((k) => k.trim()).filter(Boolean);

	const id = newId();
	await fsp.writeFile(partFile(id), '');
	const t = now();
	run(
		`INSERT INTO uploads (id, album_id, replace_id, filename, size, received, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		id,
		albumId,
		replaceId,
		filename,
		size,
		JSON.stringify(meta),
		t,
		t
	);
	return { id, chunkSize: chunkSize(), received: 0 };
}

const busy = new Set<string>();

/**
 * Les resten av en forespørsel vi avviser, så klienten får svaret vårt i stedet for et brutt samband
 * (og f.eks. kan se hvor mye serveren har). Maks litt mer enn én bit – større enn det leses ikke.
 */
async function discard(body: ReadableStream<Uint8Array> | null) {
	if (!body) return;
	let n = 0;
	try {
		for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
			n += chunk.byteLength;
			if (n > MAX_CHUNK_BYTES * 1.25) break;
		}
	} catch {
		// klienten ga seg
	}
}

/** Skriver én bit. `offset` kan være en bit som allerede er sendt (et nytt forsøk), men aldri lenger fram enn det serveren har. */
export async function writeChunk(
	id: string,
	offset: number,
	body: ReadableStream<Uint8Array> | null,
	length: number | null
): Promise<{ received: number; size: number }> {
	const row = getRow(id);
	const problem = (() => {
		if (!row) return new HttpError(404, 'Opplastingen finnes ikke lenger. Start på nytt.');
		if (row.photo_id) return new UploadConflict('Opplastingen er allerede fullført.', row.received);
		if (!Number.isInteger(offset) || offset < 0) return new HttpError(400, 'Ugyldig posisjon.');
		if (offset > row.received) return new UploadConflict(`Serveren har bare fått ${row.received} byte.`, row.received);
		if (length !== null && length > MAX_CHUNK_BYTES) return new HttpError(413, 'Biten er for stor.');
		if (length !== null && offset + length > row.size) return new HttpError(400, 'Mer data enn fila skulle være.');
		// SvelteKit leser ikke kroppen uten Content-Type.
		if (!body) return new HttpError(400, 'Biten er tom (send den med Content-Type: application/octet-stream).');
		if (busy.has(id)) return new UploadConflict('En annen bit lastes opp akkurat nå.', row.received);
		return null;
	})();
	if (problem || !row) {
		await discard(body);
		throw problem;
	}
	busy.add(id);
	try {
		const file = partFile(id);
		const fh = await fsp.open(file, 'r+').catch(() => null);
		if (!fh) {
			// Ryddet bort (for gammel) – klienten må starte på nytt.
			run(`DELETE FROM uploads WHERE id = ?`, id);
			await discard(body);
			throw new HttpError(404, 'Opplastingen finnes ikke lenger. Start på nytt.');
		}
		let pos = offset;
		try {
			for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
				const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				if (pos + buf.length > row.size) throw new HttpError(400, 'Mer data enn fila skulle være.');
				if (pos + buf.length - offset > MAX_CHUNK_BYTES) throw new HttpError(413, 'Biten er for stor.');
				let done = 0;
				while (done < buf.length) {
					const { bytesWritten } = await fh.write(buf, done, buf.length - done, pos + done);
					done += bytesWritten;
				}
				pos += buf.length;
			}
		} catch (err) {
			if (err instanceof HttpError) await discard(body);
			throw err;
		} finally {
			await fh.close();
		}
		const received = Math.max(row.received, pos);
		run(`UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?`, received, now(), id);
		return { received, size: row.size };
	} finally {
		busy.delete(id);
	}
}

const completing = new Map<string, Promise<Photo>>();

/** Gjør opplastingen om til et bilde/en video i albumet. Kan kalles flere ganger – gir samme resultat. */
export async function completeUpload(id: string): Promise<{ photo: Photo; created: boolean }> {
	const row = getRow(id);
	if (!row) throw new HttpError(404, 'Opplastingen finnes ikke lenger. Start på nytt.');
	if (row.photo_id) {
		const photo = getPhoto(row.photo_id);
		if (!photo) throw new HttpError(404, 'Bildet er slettet.');
		return { photo, created: false };
	}
	if (row.received !== row.size) throw new UploadConflict(`Fila er ikke ferdig lastet opp (${row.received} av ${row.size} byte).`, row.received);
	const running = completing.get(id);
	if (running) return { photo: await running, created: false };

	const job = (async () => {
		const file = partFile(id);
		const stat = await fsp.stat(file).catch(() => null);
		if (!stat || stat.size !== row.size) {
			run(`UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?`, Math.min(stat?.size ?? 0, row.size), now(), id);
			throw new UploadConflict('Fila på serveren er ufullstendig. Send resten på nytt.', Math.min(stat?.size ?? 0, row.size));
		}
		const meta = JSON.parse(row.meta) as UploadMeta;
		try {
			const photo = await ingest({
				albumId: row.album_id,
				path: file,
				filename: row.filename,
				replaceId: row.replace_id ?? undefined,
				title: meta.title,
				caption: meta.caption,
				keywords: meta.keywords,
				takenAt: meta.takenAt
			});
			run(`UPDATE uploads SET photo_id = ?, updated_at = ? WHERE id = ?`, photo.id, now(), id);
			return photo;
		} catch (err) {
			// Fila kan ikke brukes (f.eks. ukjent format): rydd vekk. Andre feil kan prøves på nytt.
			if (err instanceof HttpError && err.status < 500) {
				await fsp.rm(file, { force: true }).catch(() => {});
				run(`DELETE FROM uploads WHERE id = ?`, id);
			}
			throw err;
		}
	})().finally(() => completing.delete(id));
	completing.set(id, job);
	return { photo: await job, created: true };
}

export async function abortUpload(id: string): Promise<void> {
	if (busy.has(id) || completing.has(id)) throw new HttpError(409, 'Opplastingen er i gang.');
	run(`DELETE FROM uploads WHERE id = ?`, id);
	await fsp.rm(partFile(id), { force: true });
}

/** Rydder bort opplastinger som er avbrutt (og fullførte etter en stund). */
export async function cleanupUploads(): Promise<void> {
	const old = all<{ id: string }>(`SELECT id FROM uploads WHERE updated_at < ?`, now() - STALE_MS);
	for (const { id } of old) {
		if (busy.has(id) || completing.has(id)) continue;
		run(`DELETE FROM uploads WHERE id = ?`, id);
		await fsp.rm(partFile(id), { force: true }).catch(() => {});
	}
}
