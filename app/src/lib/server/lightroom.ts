import { tx } from './db';
import { deleteNode } from './photos';
import { createNode, findByLrRef, getNode, HttpError, updateNode, type NodeType, type Visibility } from './tree';

/**
 * Lightroom-koblingen. Pluginen sender hele «stien» av samlingssett (mapper) ned til samlingen (albumet)
 * hver gang den publiserer. Vi finner eller oppretter mappene/albumet ut fra Lightroom sine interne ID-er,
 * så navnebytter og flytting i Lightroom følger med automatisk.
 */

export interface LrParent {
	lrId: string | number;
	name: string;
	/** Brukes bare når mappa opprettes (endringer sendes med applySettings på mappa selv). */
	visibility?: Visibility;
}

export interface LrSyncInput {
	serviceKey: string;
	kind: NodeType;
	lrId: string | number;
	name: string;
	/** Fra toppnivå og nedover. */
	parents: LrParent[];
	visibility?: Visibility;
	allowDownload?: boolean;
	/** true = overstyr synlighet/nedlasting også på eksisterende album (når de endres i Lightroom). */
	applySettings?: boolean;
	/** true = bare oppdater hvis den finnes fra før (navnebytte/flytting av noe som aldri er publisert). */
	onlyIfExists?: boolean;
}

function visibilityFrom(v: unknown): Visibility | undefined {
	return v === 'private' ? 'private' : v === 'public' ? 'public' : undefined;
}

export function lrRef(serviceKey: string, kind: NodeType, lrId: string | number) {
	const key = String(serviceKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
	if (!key) throw new HttpError(400, 'serviceKey mangler.');
	const id = String(lrId).replace(/[^0-9A-Za-z_-]/g, '');
	if (!id) throw new HttpError(400, 'lrId mangler.');
	return `lr:${key}:${kind === 'folder' ? 'set' : 'col'}:${id}`;
}

function ensure(
	kind: NodeType,
	ref: string,
	name: string,
	parentId: string | null,
	settings: { visibility?: Visibility; allowDownload?: boolean; apply: boolean }
): string {
	const existing = findByLrRef(ref);
	if (!existing) {
		return createNode({
			type: kind,
			name,
			parentId,
			lrRef: ref,
			visibility: settings.visibility ?? 'public',
			allowDownload: settings.allowDownload ?? false
		});
	}
	if (existing.type !== kind) throw new HttpError(409, `«${name}» finnes allerede som en annen type.`);
	const patch: Parameters<typeof updateNode>[1] = {};
	if (existing.name !== name) patch.name = name;
	if (existing.parent_id !== parentId) patch.parentId = parentId;
	if (settings.apply) {
		if (settings.visibility && settings.visibility !== existing.visibility) patch.visibility = settings.visibility;
		if (settings.allowDownload !== undefined && (existing.allow_download === 1) !== settings.allowDownload) {
			patch.allowDownload = settings.allowDownload;
		}
	}
	if (Object.keys(patch).length) updateNode(existing.id, patch);
	return existing.id;
}

/** Finner/oppretter noden. Returnerer null bare når onlyIfExists er satt og noden ikke finnes. */
export function lrSync(input: LrSyncInput) {
	if (input.kind !== 'album' && input.kind !== 'folder') throw new HttpError(400, 'kind må være album eller folder.');
	const parents = Array.isArray(input.parents) ? input.parents : [];
	if (parents.length > 20) throw new HttpError(400, 'For mange mappenivåer (maks 20).');
	const ref = lrRef(input.serviceKey, input.kind, input.lrId);
	return tx(() => {
		if (input.onlyIfExists && !findByLrRef(ref)) return null;
		let parentId: string | null = null;
		for (const p of parents) {
			parentId = ensure('folder', lrRef(input.serviceKey, 'folder', p.lrId), String(p.name ?? ''), parentId, {
				visibility: visibilityFrom(p.visibility),
				apply: false
			});
		}
		const id = ensure(input.kind, ref, String(input.name ?? ''), parentId, {
			visibility: visibilityFrom(input.visibility),
			allowDownload: typeof input.allowDownload === 'boolean' ? input.allowDownload : undefined,
			apply: !!input.applySettings
		});
		return getNode(id)!;
	});
}

export async function lrDelete(serviceKey: string, kind: NodeType, lrId: string | number): Promise<boolean> {
	const existing = findByLrRef(lrRef(serviceKey, kind, lrId));
	if (!existing) return false;
	await deleteNode(existing.id);
	return true;
}
