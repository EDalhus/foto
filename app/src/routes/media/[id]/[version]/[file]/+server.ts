import { error, redirect } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { derivedDir, getPhoto } from '$lib/server/photos';
import { canView } from '$lib/server/tree';
import { albumOf } from '$lib/server/views';
import type { RequestHandler } from './$types';

const FILE = /^(?:[smlx]\.webp|og\.jpg)$/;

/** Webversjoner. Tilgangen sjekkes på hvert kall, så bilder i private album er beskyttet også med direkte lenke. */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!FILE.test(params.file)) error(404);
	const photo = getPhoto(params.id);
	const album = photo ? albumOf(photo) : null;
	if (!photo || !album || !canView(album, locals.user)) error(404);
	if (String(photo.version) !== params.version) redirect(302, `/media/${photo.id}/${photo.version}/${params.file}`);

	const file = path.join(derivedDir(photo.id, photo.version), params.file);
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(file);
	} catch {
		error(404);
	}
	const etag = `"${photo.id}-${photo.version}-${params.file}"`;
	const headers: Record<string, string> = {
		'content-type': params.file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
		'cache-control': album.effectivePrivate ? 'private, max-age=86400' : 'public, max-age=31536000, immutable',
		etag
	};
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	headers['content-length'] = String(stat.size);
	return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers });
};
