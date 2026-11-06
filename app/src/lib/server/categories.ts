import { all, one, run, tx } from './db';
import { newId, now } from './ids';
import { getTree, HttpError, invalidate, slugify, type TreeNode } from './tree';
import type { CardGroup, CardView, CategoryStyle } from '$lib/types';

/**
 * Kategorier deler innholdet i en mappe (eller forsiden) inn i grupper – f.eks. båtene etter rederi.
 * Hver mappe har sine egne kategorier og sin egen visning (category_style på mappa; forsiden i settings).
 * Et album hører til høyst én kategori i mappa det ligger i. Flyttes det, mister det kategorien.
 */

export const STYLES: CategoryStyle[] = ['sections', 'tags', 'filter', 'boxes', 'rows', 'stacks'];
export type StyleChoice = CategoryStyle | 'none';

/**
 * Farger kategoriene kan få (en prikk ved navnet – navnet står alltid der, fargen er bare en ekstra hjelp).
 * Samme åtte som i den validerte dataviz-paletten for mørk bakgrunn, kontrollert mot flaten her (#141416):
 * lyshet, metning, fargeblind-avstand og kontrast består alle.
 */
export const COLORS: { id: string; name: string; hex: string }[] = [
	{ id: 'blue', name: 'Blå', hex: '#3987e5' },
	{ id: 'orange', name: 'Oransje', hex: '#d95926' },
	{ id: 'aqua', name: 'Turkis', hex: '#199e70' },
	{ id: 'yellow', name: 'Gul', hex: '#c98500' },
	{ id: 'magenta', name: 'Rosa', hex: '#d55181' },
	{ id: 'green', name: 'Grønn', hex: '#008300' },
	{ id: 'violet', name: 'Lilla', hex: '#9085e9' },
	{ id: 'red', name: 'Rød', hex: '#e66767' }
];
const COLOR_HEX = new Map(COLORS.map((c) => [c.id, c.hex]));

export interface CategoryRow {
	id: string;
	parent_id: string | null;
	name: string;
	description: string;
	color: string | null;
	sort_index: number;
	created_at: number;
}

const HOME_KEY = 'home_category_style';

export function listCategories(parentId: string | null): CategoryRow[] {
	return all<CategoryRow>(`SELECT * FROM categories WHERE ifnull(parent_id, '') = ? ORDER BY sort_index, created_at, id`, parentId ?? '');
}

export function getCategory(id: string): CategoryRow | undefined {
	return one<CategoryRow>(`SELECT * FROM categories WHERE id = ?`, id);
}

function cleanName(v: unknown): string {
	const s = String(v ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!s) throw new HttpError(400, 'Skriv et navn på kategorien.');
	if (s.length > 80) throw new HttpError(400, 'Navnet er for langt (maks 80 tegn).');
	return s;
}

function cleanColor(v: unknown): string | null {
	const s = String(v ?? '').trim();
	if (!s || s === 'none') return null;
	if (!COLOR_HEX.has(s)) throw new HttpError(400, 'Ukjent farge.');
	return s;
}

function checkParent(parentId: string | null) {
	if (!parentId) return;
	const p = one<{ type: string }>(`SELECT type FROM nodes WHERE id = ?`, parentId);
	if (!p) throw new HttpError(404, 'Mappa finnes ikke.');
	if (p.type !== 'folder') throw new HttpError(400, 'Kategorier finnes bare i mapper.');
}

function nameTaken(parentId: string | null, name: string, selfId = '') {
	return !!one(
		`SELECT 1 FROM categories WHERE ifnull(parent_id, '') = ? AND lower(name) = lower(?) AND id != ?`,
		parentId ?? '',
		name,
		selfId
	);
}

export function createCategory(parentId: string | null, input: { name: unknown; color?: unknown; description?: unknown }): string {
	return tx(() => {
		checkParent(parentId);
		const name = cleanName(input.name);
		if (nameTaken(parentId, name)) throw new HttpError(400, `Det finnes allerede en kategori som heter «${name}».`);
		const max = one<{ m: number | null }>(`SELECT max(sort_index) AS m FROM categories WHERE ifnull(parent_id, '') = ?`, parentId ?? '');
		const id = newId();
		run(
			`INSERT INTO categories (id, parent_id, name, description, color, sort_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			parentId,
			name,
			String(input.description ?? '').trim().slice(0, 500),
			cleanColor(input.color),
			(max?.m ?? -1) + 1,
			now()
		);
		invalidate();
		return id;
	});
}

export function updateCategory(id: string, patch: { name?: unknown; color?: unknown; description?: unknown }): CategoryRow {
	return tx(() => {
		const row = getCategory(id);
		if (!row) throw new HttpError(404, 'Kategorien finnes ikke.');
		const name = patch.name !== undefined ? cleanName(patch.name) : row.name;
		if (name.toLowerCase() !== row.name.toLowerCase() && nameTaken(row.parent_id, name, id)) {
			throw new HttpError(400, `Det finnes allerede en kategori som heter «${name}».`);
		}
		run(
			`UPDATE categories SET name = ?, color = ?, description = ? WHERE id = ?`,
			name,
			patch.color !== undefined ? cleanColor(patch.color) : row.color,
			patch.description !== undefined ? String(patch.description ?? '').trim().slice(0, 500) : row.description,
			id
		);
		invalidate();
		return getCategory(id)!;
	});
}

/** Sletter kategorien. Albumene blir liggende i mappa, uten kategori. */
export function deleteCategory(id: string): CategoryRow {
	const row = getCategory(id);
	if (!row) throw new HttpError(404, 'Kategorien finnes ikke.');
	tx(() => {
		run(`UPDATE nodes SET category_id = NULL WHERE category_id = ?`, id);
		run(`DELETE FROM categories WHERE id = ?`, id);
	});
	invalidate();
	return row;
}

/** Flytter en kategori ett steg opp (-1) eller ned (1). */
export function moveCategory(id: string, delta: number): void {
	tx(() => {
		const row = getCategory(id);
		if (!row) throw new HttpError(404, 'Kategorien finnes ikke.');
		const list = listCategories(row.parent_id);
		const i = list.findIndex((c) => c.id === id);
		const j = i + (delta < 0 ? -1 : 1);
		if (j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j], list[i]];
		list.forEach((c, k) => run(`UPDATE categories SET sort_index = ? WHERE id = ?`, k, c.id));
	});
	invalidate();
}

/** Legger mapper/album i en kategori (eller ingen). De må ligge i mappa kategorien hører til. */
export function assignCategory(nodeIds: string[], parentId: string | null, categoryId: string | null): number {
	if (!nodeIds.length) throw new HttpError(400, 'Ingen album valgt.');
	return tx(() => {
		if (categoryId) {
			const c = getCategory(categoryId);
			if (!c || (c.parent_id ?? null) !== parentId) throw new HttpError(400, 'Kategorien hører ikke til denne mappa.');
		}
		let n = 0;
		for (const id of nodeIds) {
			const node = one<{ parent_id: string | null }>(`SELECT parent_id FROM nodes WHERE id = ?`, id);
			if (!node) throw new HttpError(404, 'Albumet finnes ikke.');
			if ((node.parent_id ?? null) !== parentId) throw new HttpError(400, 'Albumet ligger ikke i denne mappa.');
			n += Number(run(`UPDATE nodes SET category_id = ? WHERE id = ?`, categoryId, id).changes);
		}
		invalidate();
		return n;
	});
}

/** Hvordan kategoriene vises for kundene (en mappe, eller forsiden når parent er null). */
export function styleOf(parent: Pick<TreeNode, 'category_style'> | null): StyleChoice {
	const raw = parent ? parent.category_style : (one<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, HOME_KEY)?.value ?? null);
	if (raw === 'none') return 'none';
	return STYLES.includes(raw as CategoryStyle) ? (raw as CategoryStyle) : 'sections';
}

export function setStyle(parentId: string | null, style: unknown): StyleChoice {
	const s = String(style ?? '');
	if (s !== 'none' && !STYLES.includes(s as CategoryStyle)) throw new HttpError(400, 'Ukjent visning.');
	if (parentId) {
		checkParent(parentId);
		run(`UPDATE nodes SET category_style = ? WHERE id = ?`, s, parentId);
	} else {
		run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, HOME_KEY, s);
	}
	invalidate();
	return s as StyleChoice;
}

export const colorHex = (id: string | null | undefined) => (id ? (COLOR_HEX.get(id) ?? null) : null);

/** Kategoriene i en mappe, med hvor mange mapper og album hver har (til admin). */
export function categoriesWithCounts(parentId: string | null) {
	const children = parentId ? (getTree().byId.get(parentId)?.children ?? []) : getTree().roots;
	return listCategories(parentId).map((c) => ({
		id: c.id,
		name: c.name,
		description: c.description,
		color: c.color,
		hex: colorHex(c.color),
		count: children.filter((n) => n.category_id === c.id).length
	}));
}

/**
 * Deler kortene i grupper etter kategori, i kategorienes rekkefølge. Kort uten kategori kommer sist («Andre»).
 * null når det ikke er noe å gruppere (visningen er slått av, eller ingen av kortene har kategori).
 */
export function groupCards(
	parent: Pick<TreeNode, 'id' | 'category_style'> | null,
	nodes: TreeNode[],
	cards: CardView[]
): { style: CategoryStyle; groups: CardGroup[] } | null {
	const style = styleOf(parent);
	if (style === 'none') return null;
	const cats = listCategories(parent?.id ?? null);
	if (!cats.length) return null;
	const byNode = new Map(nodes.map((n) => [n.id, n.category_id]));
	const used = new Set<string>();
	const slugOf = (name: string) => {
		const base = slugify(name);
		let s = base;
		for (let i = 2; used.has(s); i++) s = `${base}-${i}`;
		used.add(s);
		return s;
	};
	const groups: CardGroup[] = [];
	for (const c of cats) {
		const color = colorHex(c.color);
		const list = cards.filter((card) => byNode.get(card.id) === c.id).map((card) => ({ ...card, category: { name: c.name, color } }));
		if (list.length) groups.push({ id: c.id, name: c.name, slug: slugOf(c.name), description: c.description, color, cards: list });
	}
	if (!groups.length) return null;
	const known = new Set(cats.map((c) => c.id));
	const rest = cards.filter((card) => {
		const cid = byNode.get(card.id);
		return !cid || !known.has(cid);
	});
	if (rest.length) groups.push({ id: null, name: 'Andre', slug: slugOf('andre'), description: '', color: null, cards: rest });
	return { style, groups };
}
