import { json } from '@sveltejs/kit';
import { api, readJson, requireAdmin } from '$lib/server/http';
import { lrDelete } from '$lib/server/lightroom';
import { deleteNode } from '$lib/server/photos';
import { getNode, HttpError, type NodeType } from '$lib/server/tree';
import type { RequestHandler } from './$types';

/**
 * Slett en mappe/et album som er slettet i Lightroom. Identifiseres med Lightroom sin ID (kind + lrId),
 * eller med vår egen ID (id) hvis Lightroom bare kjenner den.
 */
export const POST: RequestHandler = (event) =>
	api(async () => {
		requireAdmin(event);
		const body = await readJson<{ serviceKey?: string; kind?: NodeType; lrId?: string | number; id?: string }>(
			event.request
		);
		if (body.kind && body.lrId !== undefined && body.lrId !== null && body.lrId !== '') {
			if (body.kind !== 'album' && body.kind !== 'folder') throw new HttpError(400, 'kind må være album eller folder.');
			const deleted = await lrDelete(String(body.serviceKey ?? ''), body.kind, body.lrId);
			if (deleted || !body.id) return json({ ok: true, deleted });
		}
		if (body.id) {
			const node = getNode(String(body.id));
			if (!node) return json({ ok: true, deleted: false });
			await deleteNode(node.id);
			return json({ ok: true, deleted: true });
		}
		if (!body.kind) throw new HttpError(400, 'Mangler kind/lrId eller id.');
		return json({ ok: true, deleted: false });
	});
