import { json } from '@sveltejs/kit';
import { api, requireAdmin } from '$lib/server/http';
import { abortUpload, UploadConflict, writeChunk } from '$lib/server/uploads';
import type { RequestHandler } from './$types';

/** Én bit av fila: PUT /api/v1/uploads/:id?offset=N med rå byte i kroppen. */
export const PUT: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const offset = Number(event.url.searchParams.get('offset') ?? event.request.headers.get('x-upload-offset') ?? NaN);
		const len = event.request.headers.get('content-length');
		try {
			return json(await writeChunk(event.params.id, offset, event.request.body, len === null ? null : Number(len)));
		} catch (err) {
			if (err instanceof UploadConflict) return json({ error: err.message, received: err.received }, { status: 409 });
			throw err;
		}
	});

/** Avbryt og rydd vekk. */
export const DELETE: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		await abortUpload(event.params.id);
		return new Response(null, { status: 204 });
	});
