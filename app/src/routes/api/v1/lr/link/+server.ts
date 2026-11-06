import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { lrLink, type LrLinkInput } from '$lib/server/lightroom';
import type { RequestHandler } from './$types';

/** Kobler mapper og album som er laget på nettstedet til samlingene «Synkroniser med Foto» laget i Lightroom. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<{ serviceKey?: string; links?: LrLinkInput[] }>(event.request);
		return json({ results: lrLink(body.serviceKey, body.links ?? []) });
	});
