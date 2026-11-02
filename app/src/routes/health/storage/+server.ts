import { json } from '@sveltejs/kit';
import { checkHealth, storeHealth } from '$lib/server/worker';
import type { RequestHandler } from './$types';

/** For Uptime Kuma: 200 når lagringen (UNAS) svarer, ellers 503. Viser ingen detaljer. */
export const GET: RequestHandler = async () => {
	let h = storeHealth();
	if (!h.checkedAt || Date.now() - h.checkedAt > 90_000) h = await checkHealth();
	return json({ ok: !!h.ok }, { status: h.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
