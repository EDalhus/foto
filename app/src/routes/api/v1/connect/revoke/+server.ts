import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { HttpError } from '$lib/server/tree';
import { run } from '$lib/server/db';
import { sha256 } from '$lib/server/ids';
import type { RequestHandler } from './$types';

/** «Koble fra» i Lightroom: sletter nøkkelen som brukes i dette kallet. */
export const POST: RequestHandler = (event) =>
	api(() => {
		const auth = event.request.headers.get('authorization') ?? '';
		if (event.locals.authVia !== 'token' || !auth.startsWith('Bearer ')) throw new HttpError(401, 'Ikke innlogget');
		run(`DELETE FROM api_tokens WHERE token_hash = ?`, sha256(auth.slice(7).trim()));
		return json({ ok: true });
	});
