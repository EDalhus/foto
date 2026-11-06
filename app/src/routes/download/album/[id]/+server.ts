import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { contentDisposition } from '$lib/server/http';
import { downloadName, listPhotos, pendingFile, type Photo } from '$lib/server/photos';
import { originalStore } from '$lib/server/storage';
import { recordDownload } from '$lib/server/stats';
import { canDownload, canView, getNode } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** En strøm som ikke åpner kilden før zip-fila faktisk kommer til denne fila. */
function lazy(open: () => Promise<Readable>): Readable {
	let source: Readable | null = null;
	let opening = false;
	const out = new Readable({
		read() {
			if (source) {
				source.resume();
				return;
			}
			if (opening) return;
			opening = true;
			open().then(
				(s) => {
					source = s;
					s.on('data', (chunk) => {
						if (!out.push(chunk)) s.pause();
					});
					s.on('end', () => out.push(null));
					s.on('error', (err) => out.destroy(err));
				},
				(err) => out.destroy(err)
			);
		},
		destroy(err, cb) {
			source?.destroy();
			cb(err);
		}
	});
	return out;
}

async function openOriginal(photo: Photo): Promise<Readable> {
	if (photo.original_state === 'pending') {
		const file = pendingFile(photo);
		if (await fsp.stat(file).catch(() => null)) return fs.createReadStream(file);
	}
	const obj = await originalStore().get(photo.original_key);
	if (!obj) throw new Error(`Originalen mangler: ${photo.original_key}`);
	return Readable.fromWeb(obj.body as never);
}

/** Hele albumet som zip (ukomprimert – JPEG lar seg ikke komprimere mer uansett). */
export const GET: RequestHandler = async ({ params, locals }) => {
	const album = getNode(params.id);
	if (!album || album.type !== 'album' || !canView(album, locals.user)) error(404);
	if (!canDownload(album, locals.user)) error(403, 'Nedlasting er ikke tillatt for dette albumet.');
	const photos = listPhotos(album.id);
	recordDownload(album, locals.user, 'zip');
	if (!photos.length) error(404, 'Albumet er tomt.');

	if (photos.some((p) => p.original_state === 'stored')) {
		try {
			await originalStore().health();
		} catch {
			error(503, 'Originalene er midlertidig utilgjengelige. Prøv igjen om litt.');
		}
	}

	const zip = new yazl.ZipFile();
	const used = new Set<string>();
	for (const p of photos) {
		const full = downloadName(p);
		const ext = path.extname(full);
		const base = path.basename(full, ext) || p.id;
		let name = full;
		for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})${ext}`;
		used.add(name.toLowerCase());
		zip.addReadStream(lazy(() => openOriginal(p)), name, {
			compress: false,
			mtime: new Date(p.taken_at ?? p.created_at)
		});
	}
	zip.end();
	const stream = zip.outputStream as Readable;
	return new Response(Readable.toWeb(stream) as ReadableStream, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': contentDisposition(`${album.name}.zip`),
			'cache-control': 'private, no-store',
			'x-accel-buffering': 'no'
		}
	});
};
