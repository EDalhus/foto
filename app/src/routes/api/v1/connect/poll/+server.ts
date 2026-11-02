import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { poll } from '$lib/server/lrconnect';
import type { RequestHandler } from './$types';

/** Lightroom-pluginen spør om tilkoblingen er godkjent. Nøkkelen gis ut bare én gang. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		const body = await readJson<{ pollSecret?: unknown }>(event.request);
		if (typeof body.pollSecret !== 'string' || body.pollSecret.length < 20) {
			return json({ error: 'Mangler pollSecret' }, { status: 400 });
		}
		return json(poll(body.pollSecret), { headers: { 'cache-control': 'no-store' } });
	});
