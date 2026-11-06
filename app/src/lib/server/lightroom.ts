import { all, one, run, tx } from './db';
import { deleteNode, downloadName } from './photos';
import {
	createNode,
	findByLrRef,
	getNode,
	getTree,
	HttpError,
	invalidate,
	pathOf,
	updateNode,
	type NodeRow,
	type NodeType,
	type TreeNode,
	type Visibility
} from './tree';

/**
 * Lightroom-koblingen. Pluginen sender hele «stien» av samlingssett (mapper) ned til samlingen (albumet)
 * hver gang den publiserer. Vi finner eller oppretter mappene/albumet ut fra Lightroom sine interne ID-er,
 * så navnebytter og flytting i Lightroom følger med automatisk.
 *
 * Andre veien («Synkroniser med Foto» i pluginen): lrTree gir hele strukturen, så Lightroom kan lage
 * mapper og album som er laget på nettstedet, og lrLink kobler dem til samlingene i Lightroom.
 */

export interface LrParent {
	lrId: string | number;
	name: string;
	/** Brukes bare når mappa opprettes (endringer sendes med applySettings på mappa selv). */
	visibility?: Visibility;
	/** Vår ID, hvis Lightroom har den lagret på samlingssettet (laget med «Synkroniser med Foto»). */
	remoteId?: string;
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
	/** Vår ID, hvis Lightroom har den lagret på samlingen. */
	remoteId?: string;
}

function visibilityFrom(v: unknown): Visibility | undefined {
	return v === 'private' ? 'private' : v === 'public' ? 'public' : undefined;
}

function cleanKey(serviceKey: unknown): string {
	const key = String(serviceKey ?? '')
		.replace(/[^A-Za-z0-9_-]/g, '')
		.slice(0, 64);
	if (!key) throw new HttpError(400, 'serviceKey mangler.');
	return key;
}

export function lrRef(serviceKey: string, kind: NodeType, lrId: string | number) {
	const key = cleanKey(serviceKey);
	const id = String(lrId).replace(/[^0-9A-Za-z_-]/g, '');
	if (!id) throw new HttpError(400, 'lrId mangler.');
	return `lr:${key}:${kind === 'folder' ? 'set' : 'col'}:${id}`;
}

/** lr_ref → hvilken Lightroom-tjeneste og samling noden er koblet til. */
export function parseLrRef(ref: string | null | undefined): { serviceKey: string; kind: NodeType; lrId: string } | null {
	const m = /^lr:([A-Za-z0-9_-]+):(set|col):([0-9A-Za-z_-]+)$/.exec(ref ?? '');
	return m ? { serviceKey: m[1], kind: m[2] === 'set' ? 'folder' : 'album', lrId: m[3] } : null;
}

/**
 * Noden Lightroom-samlingen hører til. Finnes den ikke via lr_ref, men Lightroom har lagret vår ID på
 * samlingen (den ble laget med «Synkroniser med Foto», men koblingen kom aldri fram), kobles den her –
 * så lenge noden ikke allerede er koblet til noe annet.
 */
function findOrAdopt(kind: NodeType, ref: string, remoteId: unknown): NodeRow | undefined {
	const existing = findByLrRef(ref);
	if (existing || typeof remoteId !== 'string' || !remoteId) return existing;
	const node = one<NodeRow>(`SELECT * FROM nodes WHERE id = ?`, remoteId);
	if (!node || node.type !== kind || node.lr_ref) return undefined;
	run(`UPDATE nodes SET lr_ref = ? WHERE id = ?`, ref, node.id);
	invalidate();
	return { ...node, lr_ref: ref };
}

function ensure(
	kind: NodeType,
	ref: string,
	name: string,
	parentId: string | null,
	settings: { visibility?: Visibility; allowDownload?: boolean; apply: boolean },
	remoteId?: unknown
): string {
	const existing = findOrAdopt(kind, ref, remoteId);
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
		if (input.onlyIfExists && !findOrAdopt(input.kind, ref, input.remoteId)) return null;
		let parentId: string | null = null;
		for (const p of parents) {
			parentId = ensure(
				'folder',
				lrRef(input.serviceKey, 'folder', p.lrId),
				String(p.name ?? ''),
				parentId,
				{ visibility: visibilityFrom(p.visibility), apply: false },
				p.remoteId
			);
		}
		const id = ensure(
			input.kind,
			ref,
			String(input.name ?? ''),
			parentId,
			{
				visibility: visibilityFrom(input.visibility),
				allowDownload: typeof input.allowDownload === 'boolean' ? input.allowDownload : undefined,
				apply: !!input.applySettings
			},
			input.remoteId
		);
		return getNode(id)!;
	});
}

export async function lrDelete(serviceKey: string, kind: NodeType, lrId: string | number): Promise<boolean> {
	const existing = findByLrRef(lrRef(serviceKey, kind, lrId));
	if (!existing) return false;
	await deleteNode(existing.id);
	return true;
}

// --- «Synkroniser med Foto» ---

export interface LrTreeNode {
	id: string;
	type: NodeType;
	name: string;
	parentId: string | null;
	visibility: Visibility;
	allowDownload: boolean;
	url: string;
	path: string;
	/** null = laget på nettstedet, ikke koblet til Lightroom. 'other' = koblet til en annen Lightroom-tjeneste (katalog). */
	link: { lrId: string } | 'other' | null;
	/** Bare album: id-ene til bildene, i albumets rekkefølge. */
	photoIds?: string[];
}

/** Hele strukturen, mapper før det som ligger i dem. */
export function lrTree(serviceKey: unknown, origin: string): LrTreeNode[] {
	const key = cleanKey(serviceKey);
	const photos = new Map<string, string[]>();
	for (const r of all<{ album_id: string; id: string }>(
		`SELECT album_id, id FROM photos ORDER BY album_id, sort_index, created_at, id`
	)) {
		const list = photos.get(r.album_id);
		if (list) list.push(r.id);
		else photos.set(r.album_id, [r.id]);
	}
	const out: LrTreeNode[] = [];
	const walk = (list: TreeNode[]) => {
		for (const n of list) {
			const ref = parseLrRef(n.lr_ref);
			const node: LrTreeNode = {
				id: n.id,
				type: n.type,
				name: n.name,
				parentId: n.parent_id,
				visibility: n.visibility,
				allowDownload: n.allow_download === 1,
				url: `${origin}/a/${n.id}`,
				path: pathOf(n),
				link: ref ? (ref.serviceKey === key && ref.kind === n.type ? { lrId: ref.lrId } : 'other') : null
			};
			if (n.type === 'album') node.photoIds = photos.get(n.id) ?? [];
			out.push(node);
			walk(n.children);
		}
	};
	walk(getTree().roots);
	return out;
}

export interface LrPhotoInfo {
	id: string;
	/** Navnet fila ble lastet opp med. */
	filename: string;
	/** Navnet originalen lastes ned med (riktig filendelse). */
	downloadName: string;
	/** Opptakstid som veggklokke («2026-10-07T14:30:00»), slik den står i EXIF. */
	takenAt: string | null;
	width: number;
	height: number;
	bytes: number;
	mime: string;
	url: string;
}

export function lrAlbumPhotos(albumId: string, origin: string): LrPhotoInfo[] {
	const node = getNode(albumId);
	if (!node || node.type !== 'album') throw new HttpError(404, 'Albumet finnes ikke.');
	return all<{
		id: string;
		filename: string;
		original_key: string;
		taken_at: number | null;
		width: number;
		height: number;
		bytes: number;
		mime: string;
	}>(
		`SELECT id, filename, original_key, taken_at, width, height, bytes, mime FROM photos WHERE album_id = ? ORDER BY sort_index, created_at, id`,
		albumId
	).map((p) => ({
		id: p.id,
		filename: p.filename,
		downloadName: downloadName(p),
		// taken_at er veggklokka lagret som om den var UTC (se parseExifDate).
		takenAt: p.taken_at == null ? null : new Date(p.taken_at).toISOString().slice(0, 19),
		width: p.width,
		height: p.height,
		bytes: p.bytes,
		mime: p.mime,
		url: `${origin}/i/${p.id}`
	}));
}

export interface LrLinkInput {
	id: string;
	kind: NodeType;
	lrId: string | number;
	/** Noden er koblet til en samling i samme tjeneste som ikke finnes i Lightroom lenger: koble om. */
	relink?: boolean;
}

export type LrLinkResult = { id: string; ok: true } | { id: string; ok: false; error: string };

/** Kobler mapper/album på nettstedet til samlinger i Lightroom. Hver kobling lykkes eller feiler for seg. */
export function lrLink(serviceKey: unknown, links: LrLinkInput[]): LrLinkResult[] {
	const key = cleanKey(serviceKey);
	if (!Array.isArray(links)) throw new HttpError(400, 'links mangler.');
	if (links.length > 5000) throw new HttpError(400, 'For mange koblinger på én gang (maks 5000).');
	let changed = false;
	const results = tx(() =>
		links.map((l): LrLinkResult => {
			const id = String(l?.id ?? '');
			try {
				const row = one<{ id: string; type: NodeType; name: string; lr_ref: string | null }>(
					`SELECT id, type, name, lr_ref FROM nodes WHERE id = ?`,
					id
				);
				if (!row) throw new HttpError(404, 'Finnes ikke lenger på nettstedet.');
				if (l.kind !== row.type) {
					throw new HttpError(409, `«${row.name}» er ${row.type === 'folder' ? 'en mappe' : 'et album'} på nettstedet.`);
				}
				const ref = lrRef(key, row.type, l.lrId);
				if (row.lr_ref === ref) return { id, ok: true };
				const taken = findByLrRef(ref);
				if (taken) throw new HttpError(409, `Samlingen i Lightroom er allerede koblet til «${taken.name}».`);
				if (row.lr_ref) {
					const current = parseLrRef(row.lr_ref);
					if (!current || current.serviceKey !== key) {
						throw new HttpError(409, `«${row.name}» er koblet til en annen Lightroom-katalog.`);
					}
					if (!l.relink) throw new HttpError(409, `«${row.name}» er allerede koblet til en annen samling i Lightroom.`);
				}
				run(`UPDATE nodes SET lr_ref = ? WHERE id = ?`, ref, id);
				changed = true;
				return { id, ok: true };
			} catch (err) {
				if (err instanceof HttpError) return { id, ok: false, error: err.message };
				throw err;
			}
		})
	);
	if (changed) invalidate();
	return results;
}
