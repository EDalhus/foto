import { fail, redirect } from '@sveltejs/kit';
import { createNode, folderOptions, getTree, HttpError, pathOf, type TreeNode } from '$lib/server/tree';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const rows: {
		id: string;
		type: 'folder' | 'album';
		name: string;
		depth: number;
		path: string;
		visibility: string;
		effectivePrivate: boolean;
		photoCount: number;
		albumCount: number;
		allowDownload: boolean;
		fromLightroom: boolean;
	}[] = [];
	const walk = (list: TreeNode[], depth: number) => {
		for (const n of list) {
			rows.push({
				id: n.id,
				type: n.type,
				name: n.name,
				depth,
				path: pathOf(n),
				visibility: n.visibility,
				effectivePrivate: n.effectivePrivate,
				photoCount: n.photoCount,
				albumCount: n.albumCount,
				allowDownload: !!n.allow_download,
				fromLightroom: !!n.lr_ref
			});
			walk(n.children, depth + 1);
		}
	};
	walk(getTree().roots, 0);
	return { rows, folders: folderOptions() };
};

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
	}
};
