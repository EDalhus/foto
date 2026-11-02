import { error, fail, redirect } from '@sveltejs/kit';
import {
	deleteNode,
	deletePhotos,
	listPhotos,
	movePhotos,
	sortByTaken
} from '$lib/server/photos';
import {
	ancestors,
	createNode,
	folderOptions,
	getNode,
	getTree,
	HttpError,
	pathOf,
	updateNode,
	type TreeNode
} from '$lib/server/tree';
import { imageView } from '$lib/server/views';
import type { Actions, PageServerLoad } from './$types';

function albumOptions(exclude: string) {
	const out: { id: string; label: string }[] = [];
	const walk = (list: TreeNode[], prefix: string) => {
		for (const n of list) {
			const label = prefix ? `${prefix} / ${n.name}` : n.name;
			if (n.type === 'album' && n.id !== exclude) out.push({ id: n.id, label });
			walk(n.children, label);
		}
	};
	walk(getTree().roots, '');
	return out;
}

export const load: PageServerLoad = ({ params }) => {
	const node = getNode(params.id);
	if (!node) error(404, 'Finnes ikke');
	const photos =
		node.type === 'album'
			? listPhotos(node.id).map((p) => ({
					...imageView(p),
					title: p.title,
					filename: p.filename,
					bytes: p.bytes,
					stored: p.original_state === 'stored',
					error: p.original_error,
					takenAt: p.taken_at
				}))
			: [];
	return {
		node: {
			id: node.id,
			type: node.type,
			name: node.name,
			description: node.description,
			visibility: node.visibility,
			effectivePrivate: node.effectivePrivate,
			allowDownload: !!node.allow_download,
			parentId: node.parent_id,
			coverPhotoId: node.cover_photo_id,
			fromLightroom: !!node.lr_ref,
			path: pathOf(node),
			photoCount: node.photoCount
		},
		crumbs: ancestors(node).map((a) => ({ name: a.name, path: `/admin/node/${a.id}` })),
		children: node.children.map((c) => ({
			id: c.id,
			type: c.type,
			name: c.name,
			photoCount: c.photoCount,
			albumCount: c.albumCount,
			isPrivate: c.effectivePrivate
		})),
		photos,
		folders: folderOptions(node),
		albums: node.type === 'album' ? albumOptions(node.id) : []
	};
};

async function guard<T>(fn: () => Promise<T> | T) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof HttpError) return fail(err.status, { error: err.message });
		throw err;
	}
}

function ids(form: FormData) {
	return form.getAll('photo').map(String).filter(Boolean);
}

export const actions: Actions = {
	save: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const node = getNode(params.id);
			if (!node) throw new HttpError(404, 'Finnes ikke');
			updateNode(params.id, {
				name: String(form.get('name') ?? ''),
				description: String(form.get('description') ?? ''),
				visibility: form.get('visibility') === 'private' ? 'private' : 'public',
				allowDownload: node.type === 'album' ? form.get('allowDownload') === 'on' : undefined,
				parentId: String(form.get('parentId') ?? '') || null
			});
			return { saved: true };
		}),

	delete: ({ params }) =>
		guard(async () => {
			const node = getNode(params.id);
			const parent = node?.parent_id;
			await deleteNode(params.id);
			redirect(303, parent ? `/admin/node/${parent}` : '/admin');
		}),

	create: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const id = createNode({
				type: form.get('type') === 'folder' ? 'folder' : 'album',
				name: String(form.get('name') ?? ''),
				parentId: params.id,
				visibility: form.get('visibility') === 'private' ? 'private' : 'public'
			});
			redirect(303, `/admin/node/${id}`);
		}),

	deletePhotos: ({ request }) =>
		guard(async () => {
			const list = ids(await request.formData());
			if (!list.length) throw new HttpError(400, 'Ingen bilder valgt.');
			const deleted = await deletePhotos(list);
			return { message: `Slettet ${deleted.length} bilde${deleted.length === 1 ? '' : 'r'}.` };
		}),

	movePhotos: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const list = ids(form);
			if (!list.length) throw new HttpError(400, 'Ingen bilder valgt.');
			movePhotos(list, String(form.get('target') ?? ''));
			return { message: `Flyttet ${list.length} bilde${list.length === 1 ? '' : 'r'}.` };
		}),

	setCover: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			updateNode(params.id, { coverPhotoId: String(form.get('photo') ?? '') || null });
			return { message: 'Forsidebilde oppdatert.' };
		}),

	sortByDate: ({ params }) =>
		guard(() => {
			sortByTaken(params.id);
			return { message: 'Sortert etter dato tatt.' };
		})
};
