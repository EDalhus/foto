/**
 * Hvem ser en mappe eller et album? Brukes av adminsidene.
 *
 * - Offentlig: alle (noden og mappene over er offentlige).
 * - Privat: bare administratoren og gruppene den er delt med.
 * - Kunde: privat og delt med minst én kundegruppe (kunden logger inn med lenke, kan velge favoritter).
 *
 * Deling av en mappe gjelder alt under den («arvet»).
 */
import { all } from './db';
import { expiryDate, listGroups, membersOf, type GroupKind } from './guests';
import { getTree, type TreeNode } from './tree';
import type { AccessMode, GroupAccessView } from '$lib/types';

export type { AccessMode };

export interface NodeShare {
	id: string;
	name: string;
	kind: GroupKind;
	/** Navnet på mappa delingen er arvet fra, eller null når noden er delt direkte. */
	via: string | null;
}

/** Alle direkte delinger i ett oppslag: node-id → gruppene. */
function directShares(): Map<string, Omit<NodeShare, 'via'>[]> {
	const rows = all<{
		node_id: string;
		id: string;
		name: string;
		kind: GroupKind;
	}>(`SELECT a.node_id, g.id, g.name, g.kind FROM node_access a JOIN groups g ON g.id = a.group_id ORDER BY g.name COLLATE NOCASE`);
	const map = new Map<string, Omit<NodeShare, 'via'>[]>();
	for (const r of rows) {
		const list = map.get(r.node_id) ?? [];
		list.push({ id: r.id, name: r.name, kind: r.kind });
		map.set(r.node_id, list);
	}
	return map;
}

function sharesOf(node: TreeNode, direct: Map<string, Omit<NodeShare, 'via'>[]>): NodeShare[] {
	const out: NodeShare[] = [];
	const seen = new Set<string>();
	for (let n: TreeNode | null = node; n; n = n.parent) {
		for (const g of direct.get(n.id) ?? []) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			out.push({ ...g, via: n === node ? null : n.name });
		}
	}
	return out;
}

export function modeOf(node: TreeNode, shares: { kind: GroupKind }[]): AccessMode {
	if (!node.effectivePrivate) return 'public';
	return shares.some((s) => s.kind === 'client') ? 'client' : 'private';
}

/** Mappa som gjør noden privat selv om den selv står som offentlig. */
export function privateAncestor(node: TreeNode): TreeNode | null {
	if (node.visibility === 'private') return null;
	for (let p = node.parent; p; p = p.parent) if (p.visibility === 'private') return p;
	return null;
}

/** Til biblioteket: modus og delinger for alle mapper og album. */
export function accessForAll(): Map<string, { mode: AccessMode; shares: NodeShare[] }> {
	const direct = directShares();
	const out = new Map<string, { mode: AccessMode; shares: NodeShare[] }>();
	for (const n of getTree().byId.values()) {
		const shares = sharesOf(n, direct);
		out.set(n.id, { mode: modeOf(n, shares), shares });
	}
	return out;
}

/** Til albumsiden: alle grupper med medlemmer og om de har tilgang (direkte eller arvet). */
export function accessDetails(node: TreeNode): {
	mode: AccessMode;
	privateVia: string | null;
	groups: GroupAccessView[];
} {
	const shares = sharesOf(node, directShares());
	const byId = new Map(shares.map((s) => [s.id, s]));
	const t = Date.now();
	const groups = listGroups().map((g) => {
		const s = byId.get(g.id);
		return {
			id: g.id,
			name: g.name,
			kind: g.kind,
			download: g.download,
			expiresDate: expiryDate(g.expires_at),
			expired: !!g.expires_at && g.expires_at <= t,
			remindedAt: g.reminded_at,
			shared: !!s,
			direct: !!s && s.via === null,
			via: s?.via ?? null,
			members: membersOf(g.id).map((m) => ({
				id: m.id,
				name: m.name,
				email: m.email,
				lastLogin: m.last_login_at
			}))
		};
	});
	const anc = privateAncestor(node);
	return { mode: modeOf(node, shares), privateVia: anc?.name ?? null, groups };
}
