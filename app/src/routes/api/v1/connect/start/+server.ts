import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { cleanDevice, startConnect } from '$lib/server/lrconnect';
import type { RequestHandler } from './$types';

/** Lightroom-pluginen starter «Koble til Foto». Krever ingen innlogging – godkjenningen skjer i nettleseren. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		const body = await readJson<{ device?: unknown }>(event.request);
		const started = startConnect(cleanDevice(body.device), event.getClientAddress());
		if (!started) return json({ error: 'For mange ventende tilkoblinger. Vent litt og prøv igjen.' }, { status: 429 });
		return json({
			...started,
			url: `${event.url.origin}/koble/${started.code}`,
			interval: 2
		});
	});
