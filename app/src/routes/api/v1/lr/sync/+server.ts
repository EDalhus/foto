import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { lrSync, type LrSyncInput } from '$lib/server/lightroom';
import { pathOf } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/** Finn/opprett mappe eller album for en Lightroom-samling (og alle mappene over den). */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<LrSyncInput>(event.request);
		const node = lrSync(body);
		if (!node) return json({ id: null });
		return json({
			id: node.id,
			url: `${event.url.origin}/a/${node.id}`,
			path: pathOf(node),
			visibility: node.visibility,
			allowDownload: node.allow_download === 1
		});
	});
