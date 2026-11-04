import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { derivedDir, getPhoto } from '$lib/server/photos';
import { canView } from '$lib/server/tree';
import { albumOf } from '$lib/server/views';
import { ensureWatermarked, getWatermark, WATERMARKED, watermarkFor, wmName } from '$lib/server/watermark';
import type { RequestHandler } from './$types';

const FILE = /^(?:wm(\d+)-)?([smlx]\.webp|og\.jpg)$/;

/** Webversjoner. Tilgangen sjekkes på hvert kall, så bilder i private album er beskyttet også med direkte lenke. */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	const m = FILE.exec(params.file);
	if (!m) error(404);
	const photo = getPhoto(params.id);
	const album = photo ? albumOf(photo) : null;
	if (!photo || !album || !canView(album, locals.user)) error(404);

	// Vannmerke: den som skal ha vannmerke, får det uansett hvilken URL som brukes.
	const base = m[2];
	const wm = WATERMARKED.has(base) ? watermarkFor(album, locals.user) : null;
	const asked = m[1] !== undefined ? Number(m[1]) : null;
	const current = getWatermark();
	const want = wm ?? (asked !== null && current.enabled && current.text && WATERMARKED.has(base) ? current.rev : null);
	const name = want !== null ? wmName(base, want) : base;
	if (String(photo.version) !== params.version || name !== params.file) {
		return new Response(null, {
			status: 302,
			headers: { location: `/media/${photo.id}/${photo.version}/${name}`, 'cache-control': 'private, no-store' }
		});
	}

	let file = path.join(derivedDir(photo.id, photo.version), base);
	if (want !== null) {
		try {
			file = await ensureWatermarked(photo.id, photo.version, base);
		} catch (err) {
			console.error('[foto] Vannmerke feilet:', err);
			error(500);
		}
	}
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(file);
	} catch {
		error(404);
	}
	const etag = `"${photo.id}-${photo.version}-${params.file}"`;
	const headers: Record<string, string> = {
		'content-type': params.file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
		// Uten vannmerke kan samme URL gi omdirigering til andre – da må ikke svaret deles av mellomlagre.
		'cache-control': album.effectivePrivate
			? 'private, max-age=86400'
			: want === null && current.enabled && WATERMARKED.has(base)
				? 'private, max-age=31536000, immutable'
				: 'public, max-age=31536000, immutable',
		etag
	};
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	headers['content-length'] = String(stat.size);
	return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers });
};
