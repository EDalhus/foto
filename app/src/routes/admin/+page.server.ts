import { fail, redirect } from '@sveltejs/kit';
import { tx } from '$lib/server/db';
import { accessForAll } from '$lib/server/access';
import { getGroup, grantAccess, listGroups } from '$lib/server/guests';
import { createNode, folderOptions, getNode, getTree, HttpError, pathOf, updateNode, type TreeNode } from '$lib/server/tree';
import { cardViews } from '$lib/server/views';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const access = accessForAll();
	const tree = getTree();
	const all: TreeNode[] = [];
	const walk = (list: TreeNode[]) => {
		for (const n of list) {
			all.push(n);
			walk(n.children);
		}
	};
	walk(tree.roots);
	const covers = new Map(cardViews(all, locals.user).map((c) => [c.id, c.cover]));
	const rows = all.map((n) => {
		const a = access.get(n.id);
		const ancestors: string[] = [];
		for (let p = n.parent; p; p = p.parent) ancestors.unshift(p.id);
		const cover = covers.get(n.id);
		return {
			id: n.id,
			type: n.type,
			name: n.name,
			depth: ancestors.length,
			ancestors,
			trail: ancestors.map((id) => tree.byId.get(id)?.name ?? '').join(' / '),
			path: pathOf(n),
			hasChildren: n.children.length > 0,
			visibility: n.visibility,
			mode: a?.mode ?? 'public',
			clients: a?.shares.filter((s) => s.kind === 'client').map((s) => s.name) ?? [],
			groups: a?.shares.map((s) => s.name) ?? [],
			photoCount: n.photoCount,
			albumCount: n.albumCount,
			allowDownload: !!n.allow_download,
			fromLightroom: !!n.lr_ref,
			latest: n.photoCount ? n.latest : null,
			cover: cover ? { src: cover.src, srcset: cover.srcset, color: cover.color } : null
		};
	});
	return {
		rows,
		folders: folderOptions(),
		groups: listGroups().map((g) => ({ id: g.id, name: g.name, kind: g.kind }))
	};
};

function guard<T>(fn: () => T) {
	try {
		return fn();
	} catch (err) {
		if (err instanceof HttpError) return fail(err.status, { error: err.message });
		throw err;
	}
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const actions: Actions = {
	create: async ({ request }) => {
		const form = await request.formData();
		try {
			const id = createNode({
				type: form.get('type') === 'folder' ? 'folder' : 'album',
				name: String(form.get('name') ?? ''),
				parentId: String(form.get('parentId') ?? '') || null,
				visibility: form.get('visibility') === 'private' ? 'private' : 'public',
				allowDownload: form.get('allowDownload') === 'on'
			});
			redirect(303, `/admin/node/${id}`);
		} catch (err) {
			if (err instanceof HttpError) return fail(err.status, { error: err.message });
			throw err;
		}
	},

	/** Flere på en gang: gjør offentlig/privat, del med en gruppe eller flytt til en mappe. */
	bulk: async ({ request }) => {
		const form = await request.formData();
		const ids = [...new Set(form.getAll('id').map(String))].filter((id) => getNode(id));
		const op = String(form.get('op') ?? '');
		return guard(() => {
			if (!ids.length) throw new HttpError(400, 'Ingenting er valgt.');
			const what = count(ids.length, 'element', 'elementer');
			if (op === 'public' || op === 'private') {
				tx(() => ids.forEach((id) => updateNode(id, { visibility: op })));
				return { message: op === 'public' ? `${what} er gjort offentlig.` : `${what} er gjort privat.`, done: true };
			}
			if (op === 'share') {
				const group = getGroup(String(form.get('group') ?? ''));
				if (!group) throw new HttpError(400, 'Velg en gruppe.');
				tx(() => ids.forEach((id) => grantAccess(group.id, id)));
				return { message: `${what} er delt med «${group.name}».`, done: true };
			}
			if (op === 'move') {
				const target = String(form.get('target') ?? '') || null;
				// Flytt bare de øverste – det som ligger i en valgt mappe, følger med.
				const chosen = new Set(ids);
				const top = ids.filter((id) => {
					for (let p = getNode(id)?.parent; p; p = p.parent) if (chosen.has(p.id)) return false;
					return true;
				});
				const failed: string[] = [];
				let moved = 0;
				for (const id of top) {
					try {
						updateNode(id, { parentId: target });
						moved++;
					} catch (err) {
						if (!(err instanceof HttpError)) throw err;
						failed.push(`${getNode(id)?.name}: ${err.message}`);
					}
				}
				const where = target ? `«${getNode(target)?.name}»` : 'toppnivå';
				if (failed.length && !moved) throw new HttpError(400, failed.join(' '));
				return { message: `Flyttet ${count(moved, 'element', 'elementer')} til ${where}.${failed.length ? ` Hoppet over: ${failed.join(' ')}` : ''}`, done: true };
			}
			throw new HttpError(400, 'Ukjent handling.');
		});
	}
};
