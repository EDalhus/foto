import { json } from '@sveltejs/kit';
import { api, requireAdmin } from '$lib/server/http';
import { completeUpload, UploadConflict } from '$lib/server/uploads';
import type { RequestHandler } from './$types';

/** Hele fila er sendt: lag bildet/videoen. Svarer som POST /api/v1/albums/:id/photos. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		try {
			const { photo, created } = await completeUpload(event.params.id);
			return json(
				{ id: photo.id, version: photo.version, kind: photo.kind, url: `${event.url.origin}/i/${photo.id}` },
				{ status: created ? 201 : 200 }
			);
		} catch (err) {
			if (err instanceof UploadConflict) return json({ error: err.message, received: err.received }, { status: 409 });
			throw err;
		}
	});
