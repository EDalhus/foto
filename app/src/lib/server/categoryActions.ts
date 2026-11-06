import { fail, type RequestEvent } from '@sveltejs/kit';
import { assignCategory, createCategory, deleteCategory, getCategory, moveCategory, setStyle, updateCategory } from './categories';
import { HttpError } from './tree';

/**
 * Skjemahandlingene for kategorier. Brukes både på mappesidene i admin (kategoriene i mappa) og på
 * Bibliotek (kategoriene på forsiden): `parentOf` sier hvilken mappe det gjelder (null = forsiden).
 */

async function guard<T>(fn: () => Promise<T> | T) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof HttpError) return fail(err.status, { error: err.message });
		throw err;
	}
}

const STYLE_NAMES: Record<string, string> = {
	sections: 'Overskrifter',
	tags: 'Merkelapp',
	filter: 'Filterknapper',
	boxes: 'Bokser',
	rows: 'Rader',
	stacks: 'Bunker',
	none: 'Av'
};

/** Kategorien må høre til mappa siden gjelder – ellers kunne et skjema endre kategoriene i en annen mappe. */
function own(id: string, parentId: string | null) {
	const c = getCategory(id);
	if (!c || (c.parent_id ?? null) !== parentId) throw new HttpError(404, 'Kategorien finnes ikke.');
	return c;
}

export function categoryActions(parentOf: (event: RequestEvent) => string | null) {
	return {
		categoryCreate: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				const parentId = parentOf(event);
				const id = createCategory(parentId, { name: form.get('name'), color: form.get('color') });
				// «Ny kategori …» fra et album i lista: legg albumet i den med en gang.
				const nodes = form.getAll('node').map(String).filter(Boolean);
				if (nodes.length) assignCategory(nodes, parentId, id);
				return { message: `Kategorien «${getCategory(id)?.name}» er laget.`, categoryId: id };
			}),

		categoryUpdate: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				own(String(form.get('id') ?? ''), parentOf(event));
				const c = updateCategory(String(form.get('id')), {
					name: form.has('name') ? form.get('name') : undefined,
					color: form.has('color') ? form.get('color') : undefined,
					description: form.has('description') ? form.get('description') : undefined
				});
				return { message: `«${c.name}» er lagret.` };
			}),

		categoryDelete: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				own(String(form.get('id') ?? ''), parentOf(event));
				const c = deleteCategory(String(form.get('id')));
				return { message: `Kategorien «${c.name}» er slettet. Albumene ligger der de lå.` };
			}),

		categoryMove: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				own(String(form.get('id') ?? ''), parentOf(event));
				moveCategory(String(form.get('id')), form.get('dir') === 'up' ? -1 : 1);
				return { moved: true };
			}),

		categoryStyle: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				const style = setStyle(parentOf(event), form.get('style'));
				return {
					message: style === 'none' ? 'Kategoriene vises ikke for kundene.' : `Kundene ser kategoriene som «${STYLE_NAMES[style]}».`
				};
			}),

		/** Legg én eller flere mapper/album i en kategori (tom = ingen). */
		setCategory: (event: RequestEvent) =>
			guard(async () => {
				const form = await event.request.formData();
				const parentId = parentOf(event);
				const raw = String(form.get('category') ?? '');
				const category = raw ? own(raw, parentId) : null;
				const nodes = form.getAll('node').map(String).filter(Boolean);
				assignCategory(nodes, parentId, category?.id ?? null);
				const what = nodes.length === 1 ? 'Albumet' : `${nodes.length} album`;
				return { message: category ? `${what} ligger nå i «${category.name}».` : `${what} har ingen kategori.` };
			})
	};
}
