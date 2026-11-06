import { all, one, run, tx } from './db';
import { newId, now } from './ids';
import type { SessionUser } from './auth';

/**
 * Albumstrukturen: mapper (folder) kan inneholde mapper og album, album inneholder bilder.
 * Strukturen er virtuell – den finnes bare i databasen, aldri som mapper på disk.
 */

export type NodeType = 'folder' | 'album';
export type Visibility = 'public' | 'private';

export interface NodeRow {
	id: string;
	parent_id: string | null;
	type: NodeType;
	name: string;
	slug: string;
	description: string;
	visibility: Visibility;
	allow_download: number;
	cover_photo_id: string | null;
	/** Album: hvor mange bilder gjestene skal velge (null = så mange de vil). */
	pick_count: number | null;
	sort_index: number;
	lr_ref: string | null;
	created_at: number;
	updated_at: number;
}

export interface TreeNode extends NodeRow {
	parent: TreeNode | null;
	children: TreeNode[];
	/** Album: egne bilder. Mappe: alle bilder i undermapper/album. */
	photoCount: number;
	/** Mappe: antall album under. */
	albumCount: number;
	/** Album: første bilde i sorteringen. */
	firstPhotoId: string | null;
	/** Nyeste opptaksdato (eller opplastingsdato) blant bildene. */
	latest: number;
	/** Eldste opptaksdato (eller opplastingsdato) blant bildene. */
	earliest: number;
	/** Privat selv, eller ligger under en privat mappe. */
	effectivePrivate: boolean;
}

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

/** URL-segmenter på toppnivå som ikke kan brukes som mappenavn. */
export const RESERVED = new Set([
	'admin',
	'api',
	'media',
	'i',
	'a',
	'download',
	'login',
	'logout',
	'koble',
	'sok',
	'health',
	'_app',
	'favicon.svg',
	'favicon.ico',
	'robots.txt'
]);

// --- Hurtigbuffer for hele treet (noen hundre rader – billig å bygge) ---

let version = 0;
let cached: { version: number; tree: Tree } | null = null;

/** Må kalles etter alle endringer i nodes eller photos. */
export function invalidate() {
	version++;
}

export interface Tree {
	byId: Map<string, TreeNode>;
	roots: TreeNode[];
}

export function getTree(): Tree {
	if (cached && cached.version === version) return cached.tree;
	const v = version;
	const rows = all<NodeRow>(`SELECT * FROM nodes`);
	const stats = all<{ album_id: string; n: number; latest: number; earliest: number }>(
		`SELECT album_id, count(*) AS n, max(coalesce(taken_at, created_at)) AS latest, min(coalesce(taken_at, created_at)) AS earliest FROM photos GROUP BY album_id`
	);
	const firsts = all<{ album_id: string; id: string }>(
		`SELECT album_id, id FROM (
			SELECT album_id, id, row_number() OVER (PARTITION BY album_id ORDER BY sort_index, created_at, id) AS rn FROM photos
		) WHERE rn = 1`
	);
	const statMap = new Map(stats.map((s) => [s.album_id, s]));
	const firstMap = new Map(firsts.map((f) => [f.album_id, f.id]));

	const byId = new Map<string, TreeNode>();
	for (const r of rows) {
		const s = statMap.get(r.id);
		byId.set(r.id, {
			...r,
			parent: null,
			children: [],
			photoCount: r.type === 'album' ? (s?.n ?? 0) : 0,
			albumCount: 0,
			firstPhotoId: firstMap.get(r.id) ?? null,
			latest: s?.latest ?? r.created_at,
			earliest: s?.earliest ?? r.created_at,
			effectivePrivate: false
		});
	}
	const roots: TreeNode[] = [];
	for (const n of byId.values()) {
		const p = n.parent_id ? byId.get(n.parent_id) : undefined;
		if (p) {
			n.parent = p;
			p.children.push(n);
		} else roots.push(n);
	}
	const finish = (list: TreeNode[], parentPrivate: boolean) => {
		for (const n of list) {
			n.effectivePrivate = parentPrivate || n.visibility === 'private';
			finish(n.children, n.effectivePrivate);
			if (n.type === 'folder') {
				n.photoCount = n.children.reduce((a, c) => a + c.photoCount, 0);
				n.albumCount = n.children.reduce((a, c) => a + (c.type === 'album' ? 1 : c.albumCount), 0);
				const filled = n.children.filter((c) => c.photoCount > 0);
				n.latest = n.children.reduce((a, c) => Math.max(a, c.latest), n.created_at);
				n.earliest = filled.reduce((a, c) => Math.min(a, c.earliest), filled.length ? Infinity : n.created_at);
			}
		}
		list.sort(compareNodes);
	};
	finish(roots, false);
	const tree = { byId, roots };
	cached = { version: v, tree };
	return tree;
}

const collator = new Intl.Collator('nb', { numeric: true, sensitivity: 'base' });

/** Manuell rekkefølge først, så mapper (alfabetisk) før album (nyeste først). */
function compareNodes(a: TreeNode, b: TreeNode) {
	if (a.sort_index !== b.sort_index) return a.sort_index - b.sort_index;
	if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
	if (a.type === 'album' && a.latest !== b.latest) return b.latest - a.latest;
	return collator.compare(a.name, b.name);
}

// --- Tilgang og stier ---

export function isAdmin(user: SessionUser | null | undefined) {
	return user?.role === 'admin';
}

export type GroupDownload = 'album' | 'yes' | 'no';
interface Grant {
	groupId: string;
	download: GroupDownload;
}

// Gjester: hvilke mapper/album brukeren har fått tilgang til via gruppene sine (utløpte grupper teller ikke).
// Bufres til neste invalidate(), eller til den første gruppa utløper.
let grantCache: { version: number; byUser: Map<string, { grants: Map<string, Grant[]>; until: number }> } = {
	version: -1,
	byUser: new Map()
};

function userGrants(userId: string): Map<string, Grant[]> {
	if (grantCache.version !== version) grantCache = { version, byUser: new Map() };
	const t = now();
	let entry = grantCache.byUser.get(userId);
	if (!entry || entry.until <= t) {
		const rows = all<{ node_id: string; group_id: string; download: GroupDownload; expires_at: number | null }>(
			`SELECT a.node_id, g.id AS group_id, g.download, g.expires_at
			 FROM node_access a JOIN group_members m ON m.group_id = a.group_id JOIN groups g ON g.id = a.group_id
			 WHERE m.user_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?)`,
			userId,
			t
		);
		const grants = new Map<string, Grant[]>();
		let until = Infinity;
		for (const r of rows) {
			if (r.expires_at) until = Math.min(until, r.expires_at);
			const list = grants.get(r.node_id) ?? [];
			list.push({ groupId: r.group_id, download: r.download });
			grants.set(r.node_id, list);
		}
		entry = { grants, until };
		grantCache.byUser.set(userId, entry);
	}
	return entry.grants;
}

export function grantedNodeIds(userId: string): Set<string> {
	return new Set(userGrants(userId).keys());
}

/** Gruppene som gir brukeren tilgang til noden (direkte eller via en mappe over). */
function grantsFor(node: TreeNode, user: SessionUser | null | undefined): Grant[] {
	if (!user || isAdmin(user)) return [];
	const granted = userGrants(user.id);
	if (!granted.size) return [];
	const out: Grant[] = [];
	for (let n: TreeNode | null = node; n; n = n.parent) out.push(...(granted.get(n.id) ?? []));
	return out;
}

/** Delt med brukeren: noden selv eller en mappe over den er delt med en av gruppene brukeren er med i. */
export function isShared(node: TreeNode, user: SessionUser | null | undefined) {
	return grantsFor(node, user).length > 0;
}

/** Favoritter er for gjester i album som er delt med dem (kunden velger bilder). */
export function canFavorite(album: TreeNode, user: SessionUser | null | undefined) {
	return !!user && !isAdmin(user) && album.type === 'album' && isShared(album, user);
}

/**
 * Kan brukeren laste ned originalene i albumet?
 * Gruppa kan overstyre albumets innstilling: «yes» (alltid), «no» (aldri) eller «album» (følg albumet).
 * Har brukeren tilgang via flere grupper, vinner den mest rause.
 */
export function canDownload(album: TreeNode, user: SessionUser | null | undefined) {
	if (isAdmin(user)) return true;
	if (!album.effectivePrivate && album.allow_download) return true;
	const grants = grantsFor(album, user);
	if (!grants.length) return !!album.allow_download && canView(album, user);
	if (grants.some((g) => g.download === 'yes')) return true;
	if (grants.some((g) => g.download === 'album')) return !!album.allow_download;
	return false;
}

export function canView(node: TreeNode, user: SessionUser | null | undefined) {
	return !node.effectivePrivate || isAdmin(user) || isShared(node, user);
}

/** Det som er delt direkte med brukeren (øverste nivå), til «Delt med deg». */
export function sharedRoots(user: SessionUser | null | undefined): TreeNode[] {
	if (!user || isAdmin(user)) return [];
	const granted = grantedNodeIds(user.id);
	const { byId } = getTree();
	const out: TreeNode[] = [];
	for (const id of granted) {
		const n = byId.get(id);
		if (!n || n.photoCount === 0) continue;
		// Hopp over det som allerede ligger under noe annet som er delt.
		let covered = false;
		for (let p = n.parent; p; p = p.parent) if (granted.has(p.id)) covered = true;
		if (!covered) out.push(n);
	}
	return out.sort((a, b) => b.latest - a.latest);
}

/** Barn som skal vises for denne brukeren. Tomme album skjules for besøkende. */
export function visibleChildren(node: TreeNode | null, user: SessionUser | null | undefined): TreeNode[] {
	const list = node ? node.children : getTree().roots;
	if (isAdmin(user)) return list;
	return list.filter((c) => canView(c, user) && c.photoCount > 0);
}

export function ancestors(node: TreeNode): TreeNode[] {
	const out: TreeNode[] = [];
	for (let p = node.parent; p; p = p.parent) out.unshift(p);
	return out;
}

export function pathOf(node: TreeNode): string {
	return '/' + [...ancestors(node), node].map((n) => n.slug).join('/');
}

export function resolvePath(segments: string[]): TreeNode | null {
	let list = getTree().roots;
	let found: TreeNode | null = null;
	for (const raw of segments) {
		const seg = raw.toLowerCase();
		found = list.find((n) => n.slug === seg) ?? null;
		if (!found) return null;
		list = found.children;
	}
	return found;
}

export function getNode(id: string): TreeNode | null {
	return getTree().byId.get(id) ?? null;
}

export function descendants(node: TreeNode): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (n: TreeNode) => {
		for (const c of n.children) {
			out.push(c);
			walk(c);
		}
	};
	walk(node);
	return out;
}

/** Alle mapper, sortert som et innrykket tre – til nedtrekkslister. */
export function folderOptions(exclude?: TreeNode): { id: string; label: string; depth: number }[] {
	const out: { id: string; label: string; depth: number }[] = [];
	const skip = new Set(exclude ? [exclude.id, ...descendants(exclude).map((d) => d.id)] : []);
	const walk = (list: TreeNode[], depth: number) => {
		for (const n of list) {
			if (n.type !== 'folder' || skip.has(n.id)) continue;
			out.push({ id: n.id, label: n.name, depth });
			walk(n.children, depth + 1);
		}
	};
	walk(getTree().roots, 0);
	return out;
}

// --- Slugs ---

export function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'o')
		.replace(/å/g, 'a')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80)
		.replace(/-+$/g, '');
	return s || 'uten-navn';
}

function uniqueSlug(name: string, parentId: string | null, selfId?: string): string {
	const base = slugify(name);
	const taken = new Set(
		all<{ slug: string }>(
			`SELECT slug FROM nodes WHERE ifnull(parent_id, '') = ? AND id != ?`,
			parentId ?? '',
			selfId ?? ''
		).map((r) => r.slug)
	);
	const blocked = (s: string) => taken.has(s) || (!parentId && RESERVED.has(s));
	if (!blocked(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}-${i}`;
		if (!blocked(candidate)) return candidate;
	}
}

// --- Endringer ---

function cleanName(name: unknown): string {
	const s = String(name ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!s) throw new HttpError(400, 'Navn mangler.');
	if (s.length > 200) throw new HttpError(400, 'Navnet er for langt (maks 200 tegn).');
	return s;
}

function checkParent(parentId: string | null): void {
	if (!parentId) return;
	const p = one<{ type: NodeType }>(`SELECT type FROM nodes WHERE id = ?`, parentId);
	if (!p) throw new HttpError(404, 'Mappa finnes ikke.');
	if (p.type !== 'folder') throw new HttpError(400, 'Album kan bare ligge i mapper, ikke i andre album.');
}

export interface CreateNodeInput {
	type: NodeType;
	name: string;
	parentId?: string | null;
	visibility?: Visibility;
	allowDownload?: boolean;
	description?: string;
	lrRef?: string | null;
}

export function createNode(input: CreateNodeInput): string {
	if (input.type !== 'folder' && input.type !== 'album') throw new HttpError(400, 'Ugyldig type.');
	const name = cleanName(input.name);
	const parentId = input.parentId || null;
	return tx(() => {
		checkParent(parentId);
		const id = newId();
		const t = now();
		run(
			`INSERT INTO nodes (id, parent_id, type, name, slug, description, visibility, allow_download, lr_ref, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			parentId,
			input.type,
			name,
			uniqueSlug(name, parentId),
			String(input.description ?? '').trim(),
			input.visibility === 'private' ? 'private' : 'public',
			input.allowDownload ? 1 : 0,
			input.lrRef ?? null,
			t,
			t
		);
		invalidate();
		return id;
	});
}

export interface UpdateNodeInput {
	name?: string;
	description?: string;
	visibility?: Visibility;
	allowDownload?: boolean;
	/** null = flytt til toppnivå */
	parentId?: string | null;
	coverPhotoId?: string | null;
	/** «Velg N bilder» (null = fritt). */
	pickCount?: number | null;
}

export function updateNode(id: string, patch: UpdateNodeInput): void {
	tx(() => {
		const row = one<NodeRow>(`SELECT * FROM nodes WHERE id = ?`, id);
		if (!row) throw new HttpError(404, 'Finnes ikke.');
		let parentId = row.parent_id;
		if (patch.parentId !== undefined && (patch.parentId || null) !== row.parent_id) {
			parentId = patch.parentId || null;
			checkParent(parentId);
			// Ikke flytt en mappe inn i seg selv eller en av sine egne undermapper.
			for (let p = parentId; p; p = one<{ parent_id: string | null }>(`SELECT parent_id FROM nodes WHERE id = ?`, p)?.parent_id ?? null) {
				if (p === id) throw new HttpError(400, 'Kan ikke flytte en mappe inn i seg selv.');
			}
		}
		const name = patch.name !== undefined ? cleanName(patch.name) : row.name;
		const slug = name !== row.name || parentId !== row.parent_id ? uniqueSlug(name, parentId, id) : row.slug;
		let cover = row.cover_photo_id;
		if (patch.coverPhotoId !== undefined) {
			cover = patch.coverPhotoId || null;
			if (cover && row.type === 'album' && !one(`SELECT 1 FROM photos WHERE id = ? AND album_id = ?`, cover, id)) {
				throw new HttpError(400, 'Forsidebildet må ligge i albumet.');
			}
			if (
				cover &&
				row.type === 'folder' &&
				!one(
					`WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id = ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
					 SELECT 1 FROM photos WHERE id = ? AND album_id IN (SELECT id FROM sub)`,
					id,
					cover
				)
			) {
				throw new HttpError(400, 'Forsidebildet må ligge i et album i mappa.');
			}
		}
		let pick = row.pick_count;
		if (patch.pickCount !== undefined) {
			pick = patch.pickCount;
			if (pick !== null && (!Number.isInteger(pick) || pick < 1 || pick > 10000)) throw new HttpError(400, 'Antallet må være et helt tall fra 1 og oppover.');
		}
		run(
			`UPDATE nodes SET parent_id = ?, name = ?, slug = ?, description = ?, visibility = ?, allow_download = ?, cover_photo_id = ?, pick_count = ?, updated_at = ? WHERE id = ?`,
			parentId,
			name,
			slug,
			patch.description !== undefined ? String(patch.description).trim() : row.description,
			patch.visibility !== undefined ? (patch.visibility === 'private' ? 'private' : 'public') : row.visibility,
			patch.allowDownload !== undefined ? (patch.allowDownload ? 1 : 0) : row.allow_download,
			cover,
			pick,
			now(),
			id
		);
		invalidate();
	});
}

/** Id-ene til alle album i undertreet (inkludert noden selv hvis den er et album). */
export function albumIdsUnder(id: string): string[] {
	return all<{ id: string }>(
		`WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id = ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
		 SELECT nodes.id FROM nodes JOIN sub ON sub.id = nodes.id WHERE nodes.type = 'album'`,
		id
	).map((r) => r.id);
}

export function findByLrRef(ref: string): NodeRow | undefined {
	return one<NodeRow>(`SELECT * FROM nodes WHERE lr_ref = ?`, ref);
}
