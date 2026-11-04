import { all } from './db';
import { getPhotosByIds, type Photo } from './photos';
import { canView, getTree, type TreeNode } from './tree';
import type { SessionUser } from './auth';

/**
 * Enkelt søk i tittel, bildetekst, stikkord og filnavn (bilder) og navn/beskrivelse (mapper og album).
 * Alle ordene må finnes. Store/små bokstaver og aksenter spiller ingen rolle.
 * Hele indeksen ligger i minnet – greit for titusener av bilder.
 */
export const normalize = (s: string) =>
	s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '');

interface Entry {
	id: string;
	album_id: string;
	text: string;
}

let index: { stamp: string; entries: Entry[] } | null = null;

function photoIndex(): Entry[] {
	// Indeksen bygges på nytt når bilder endres (antall + siste endring er nok til å merke det).
	const stamp = all<{ n: number; t: number | null }>(`SELECT count(*) AS n, max(updated_at) AS t FROM photos`)
		.map((r) => `${r.n}:${r.t}`)
		.join();
	if (index && index.stamp === stamp) return index.entries;
	const rows = all<{ id: string; album_id: string; title: string; caption: string; keywords: string; filename: string }>(
		`SELECT id, album_id, title, caption, keywords, filename FROM photos ORDER BY coalesce(taken_at, created_at) DESC`
	);
	const entries = rows.map((r) => {
		let kw: string[] = [];
		try {
			kw = JSON.parse(r.keywords);
		} catch {
			// tom
		}
		return { id: r.id, album_id: r.album_id, text: normalize([r.title, r.caption, kw.join(' '), r.filename].join(' ')) };
	});
	index = { stamp, entries };
	return entries;
}

export const terms = (q: string) =>
	normalize(q)
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
		.slice(0, 8);

export function search(q: string, user: SessionUser | null, limit = 300): { nodes: TreeNode[]; photos: Photo[]; more: boolean } {
	const words = terms(q);
	if (!words.length) return { nodes: [], photos: [], more: false };
	const matches = (text: string) => words.every((w) => text.includes(w));
	const { byId } = getTree();

	// Navn som begynner med søket kommer først, deretter ord i navnet, så resten – nyeste først innenfor hver gruppe.
	const first = words[0];
	const score = (n: TreeNode) => {
		const name = normalize(n.name);
		if (name.startsWith(first)) return 0;
		if (name.split(/[^a-z0-9æøå]+/).some((w) => w.startsWith(first))) return 1;
		return 2;
	};
	const nodes = [...byId.values()]
		.filter((n) => n.photoCount > 0 && canView(n, user) && matches(normalize(`${n.name} ${n.description}`)))
		.map((n) => ({ n, s: score(n) }))
		.sort((a, b) => a.s - b.s || b.n.latest - a.n.latest)
		.map((x) => x.n)
		.slice(0, 48);

	const allowed = new Map<string, boolean>();
	const ids: string[] = [];
	let more = false;
	for (const e of photoIndex()) {
		if (!matches(e.text)) continue;
		let ok = allowed.get(e.album_id);
		if (ok === undefined) {
			const album = byId.get(e.album_id);
			ok = !!album && canView(album, user);
			allowed.set(e.album_id, ok);
		}
		if (!ok) continue;
		if (ids.length >= limit) {
			more = true;
			break;
		}
		ids.push(e.id);
	}
	const byPhoto = new Map(getPhotosByIds(ids).map((p) => [p.id, p]));
	return { nodes, photos: ids.map((id) => byPhoto.get(id)!).filter(Boolean), more };
}
