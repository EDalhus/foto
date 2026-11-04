import { fail } from '@sveltejs/kit';
import { one } from '$lib/server/db';
import { getPhoto } from '$lib/server/photos';
import { getTree, HttpError } from '$lib/server/tree';
import { mediaFile, mediaUrl } from '$lib/server/views';
import { getWatermark, saveWatermark } from '$lib/server/watermark';
import type { Actions, PageServerLoad } from './$types';

/** Et offentlig bilde å vise vannmerket på (det nyeste). */
function samplePhoto() {
	const { byId } = getTree();
	const publicAlbums = [...byId.values()].filter((n) => n.type === 'album' && !n.effectivePrivate && n.photoCount > 0).map((n) => n.id);
	if (!publicAlbums.length) return null;
	const row = one<{ id: string }>(
		`SELECT id FROM photos WHERE album_id IN (${publicAlbums.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
		...publicAlbums
	);
	return row ? getPhoto(row.id) : null;
}

export const load: PageServerLoad = () => {
	const w = getWatermark();
	const p = samplePhoto();
	return {
		watermark: { enabled: w.enabled, text: w.text, position: w.position },
		preview: p
			? {
					w: p.width,
					h: p.height,
					plain: mediaUrl(p, 'l.webp'),
					marked: w.enabled && w.text ? mediaUrl(p, mediaFile('l.webp', w.rev)) : null
				}
			: null
	};
};

export const actions: Actions = {
	watermark: async ({ request }) => {
		const form = await request.formData();
		try {
			saveWatermark({ enabled: form.get('enabled') === 'on', text: form.get('text'), position: form.get('position') });
		} catch (err) {
			if (err instanceof HttpError) return fail(err.status, { error: err.message });
			throw err;
		}
		return { saved: true };
	}
};
