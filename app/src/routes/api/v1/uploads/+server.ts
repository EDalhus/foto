import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { startUpload, type StartInput } from '$lib/server/uploads';
import type { RequestHandler } from './$types';

/** Start en opplasting i biter (store filer, f.eks. video). Se $lib/server/uploads.ts. */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<StartInput>(event.request);
		return json(await startUpload(body), { status: 201 });
	});
