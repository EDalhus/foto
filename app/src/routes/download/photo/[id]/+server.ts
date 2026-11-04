import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentDisposition } from '$lib/server/http';
import { downloadName, getPhoto, pendingFile } from '$lib/server/photos';
import { originalStore, StoreUnavailableError } from '$lib/server/storage';
import { canDownload, canView } from '$lib/server/tree';
import { albumOf } from '$lib/server/views';
import type { RequestHandler } from './$types';

function parseRange(header: string | null): { start: number; end?: number } | undefined {
	const m = header ? /^bytes=(\d+)-(\d*)$/.exec(header.trim()) : null;
	if (!m) return undefined;
	return { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
}

/** Originalen i full oppløsning – hentes fra lagringen (UNAS) og sendes rett videre. */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	const photo = getPhoto(params.id);
	const album = photo ? albumOf(photo) : null;
	if (!photo || !album || !canView(album, locals.user)) error(404);
	if (!canDownload(album, locals.user)) error(403, 'Nedlasting er ikke tillatt for dette albumet.');

	const name = downloadName(photo);
	const headers: Record<string, string> = {
		'content-type': photo.mime,
		'content-disposition': contentDisposition(name),
		'cache-control': 'private, no-store',
		'accept-ranges': 'bytes'
	};
	const range = parseRange(request.headers.get('range'));

	// Originalen er ikke sendt til lagringen ennå – bruk den lokale kopien.
	if (photo.original_state === 'pending') {
		const file = pendingFile(photo);
		const stat = await fsp.stat(file).catch(() => null);
		if (stat) {
			const start = range ? Math.min(range.start, stat.size - 1) : 0;
			const end = range ? Math.min(range.end ?? stat.size - 1, stat.size - 1) : stat.size - 1;
			headers['content-length'] = String(end - start + 1);
			if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
			return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
				status: range ? 206 : 200,
				headers
			});
		}
	}

	try {
		const obj = await originalStore().get(photo.original_key, range);
		if (!obj) error(404, 'Originalen finnes ikke i lagringen.');
		headers['content-length'] = String(obj.length);
		if (obj.partial) headers['content-range'] = `bytes ${obj.start}-${obj.end}/${obj.total}`;
		return new Response(obj.body, { status: obj.partial ? 206 : 200, headers });
	} catch (err) {
		if (err instanceof StoreUnavailableError) {
			error(503, 'Originalen er midlertidig utilgjengelig. Prøv igjen om litt.');
		}
		throw err;
	}
};
