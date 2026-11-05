import { error, fail, redirect } from '@sveltejs/kit';
import { tx } from '$lib/server/db';
import { accessDetails, accessForAll } from '$lib/server/access';
import {
	addMember,
	createGroup,
	favoritesInAlbum,
	getGroup,
	grantAccess,
	groupIdsWithAccess,
	listGroups,
	removeMember,
	revokeAccess,
	setAccess,
	updateGroup
} from '$lib/server/guests';
import { inviteLink, sendInvite } from '$lib/server/invite';
import { mailConfigured } from '$lib/server/mail';
import { deleteNode, deletePhotos, listPhotos, movePhotos, sortByTaken } from '$lib/server/photos';
import { ancestors, createNode, folderOptions, getNode, getTree, HttpError, pathOf, updateNode, type TreeNode } from '$lib/server/tree';
import { cardViews, coverView, imageView } from '$lib/server/views';
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

export const load: PageServerLoad = ({ params, locals }) => {
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
	const cover = coverView(node, locals.user);
	const all = node.type === 'folder' ? accessForAll() : null;
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
			photoCount: node.photoCount,
			albumCount: node.albumCount
		},
		crumbs: ancestors(node).map((a) => ({
			name: a.name,
			path: `/admin/node/${a.id}`
		})),
		children: cardViews(node.children, locals.user).map((c) => {
			const a = all?.get(c.id);
			return {
				...c,
				mode: a?.mode ?? 'public',
				clients: a?.shares.filter((s) => s.kind === 'client').map((s) => s.name) ?? []
			};
		}),
		photos,
		cover: cover
			? {
					photoId: cover.photoId,
					src: cover.src,
					srcset: cover.srcset,
					color: cover.color,
					auto: !node.cover_photo_id
				}
			: null,
		access: accessDetails(node),
		favorites: node.type === 'album' ? favoritesInAlbum(node.id) : [],
		folders: folderOptions(node),
		albums: node.type === 'album' ? albumOptions(node.id) : [],
		mailReady: mailConfigured()
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

function nodeOr404(id: string) {
	const node = getNode(id);
	if (!node) throw new HttpError(404, 'Finnes ikke.');
	return node;
}

const what = (n: TreeNode) => (n.type === 'album' ? 'Albumet' : 'Mappa');
const str = (form: FormData, key: string) => String(form.get(key) ?? '');

export const actions: Actions = {
	/** Navn, beskrivelse og plassering (og synlighet/nedlasting hvis de er med i skjemaet). */
	save: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const node = nodeOr404(params.id);
			updateNode(params.id, {
				name: form.has('name') ? str(form, 'name') : undefined,
				description: form.has('description') ? str(form, 'description') : undefined,
				parentId: form.has('parentId') ? str(form, 'parentId') || null : undefined,
				visibility: form.has('visibility') ? (form.get('visibility') === 'private' ? 'private' : 'public') : undefined,
				allowDownload: node.type === 'album' && form.has('allowDownloadField') ? form.get('allowDownload') === 'on' : undefined
			});
			return { saved: true, message: 'Lagret.' };
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
				name: str(form, 'name'),
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
			return {
				message: `Slettet ${deleted.length} bilde${deleted.length === 1 ? '' : 'r'}.`
			};
		}),

	movePhotos: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const list = ids(form);
			if (!list.length) throw new HttpError(400, 'Ingen bilder valgt.');
			movePhotos(list, str(form, 'target'));
			return {
				message: `Flyttet ${list.length} bilde${list.length === 1 ? '' : 'r'}.`
			};
		}),

	/** Forsidebilde: et bilde i albumet (eller i et album i mappa), eller tomt for automatisk. */
	setCover: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const photo = str(form, 'photo') || null;
			updateNode(params.id, { coverPhotoId: photo });
			return {
				message: photo ? 'Forsidebildet er byttet.' : 'Forsidebildet velges automatisk.'
			};
		}),

	/** Setter nøyaktig hvilke grupper som har direkte tilgang (brukes av API-et og eldre skjema). */
	share: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			setAccess(params.id, form.getAll('group').map(String));
			return { message: 'Deling lagret.' };
		}),

	/** Offentlig eller privat. `removeClients` fjerner samtidig kundegruppene som er delt direkte. */
	access: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const node = nodeOr404(params.id);
			const mode = form.get('mode');
			if (mode !== 'public' && mode !== 'private') throw new HttpError(400, 'Ugyldig valg.');
			tx(() => {
				updateNode(node.id, { visibility: mode });
				if (mode === 'private' && form.get('removeClients') === '1') {
					const clients = new Set(
						listGroups()
							.filter((g) => g.kind === 'client')
							.map((g) => g.id)
					);
					for (const g of groupIdsWithAccess(node.id)) if (clients.has(g)) revokeAccess(g, node.id);
				}
			});
			if (mode === 'public') return { message: `${what(node)} er offentlig. Alle kan se det.` };
			return { message: `${what(node)} er privat.` };
		}),

	/** Del med / fjern en gruppe. `makePrivate` gjør samtidig noden privat (når den leveres til en kunde). */
	toggleGroup: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const node = nodeOr404(params.id);
			const group = getGroup(str(form, 'group'));
			if (!group) throw new HttpError(404, 'Gruppa finnes ikke.');
			if (form.get('on') === '1') {
				tx(() => {
					grantAccess(group.id, node.id);
					if (form.get('makePrivate') === '1') updateNode(node.id, { visibility: 'private' });
				});
				return { message: `Delt med «${group.name}».` };
			}
			revokeAccess(group.id, node.id);
			return { message: `«${group.name}» har ikke lenger tilgang.` };
		}),

	/** Ny gruppe (familie og venner) som får tilgang med en gang. */
	newGroup: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			const node = nodeOr404(params.id);
			const groupId = tx(() => {
				const id = createGroup(form.get('name'), 'family');
				grantAccess(id, node.id);
				return id;
			});
			return {
				message: `Gruppa «${getGroup(groupId)?.name}» er laget og har tilgang. Legg til personer under.`,
				groupId
			};
		}),

	/** Lever til en ny kunde: lager kundegruppe med personen, deler, gjør privat og sender invitasjon. */
	newClient: ({ request, params, url }) =>
		guard(async () => {
			const form = await request.formData();
			const node = nodeOr404(params.id);
			const { groupId, guest } = tx(() => {
				const id = createGroup(form.get('name'), 'client');
				const guest = addMember(id, form.get('email'), form.get('name'));
				grantAccess(id, node.id);
				updateNode(node.id, { visibility: 'private' });
				return { groupId: id, guest };
			});
			if (form.get('invite') === 'on') {
				try {
					await sendInvite(guest.id, url.origin);
					return {
						message: `Levert til ${guest.name || guest.email}. Invitasjonen er sendt til ${guest.email}.`,
						groupId
					};
				} catch (err) {
					const msg = err instanceof HttpError ? err.message : 'Klarte ikke å sende invitasjonen.';
					return fail(502, { error: `${what(node)} er delt, men: ${msg}` });
				}
			}
			return {
				message: `Levert til ${guest.name || guest.email}. Kopier lenken og send den selv.`,
				groupId
			};
		}),

	allowDownload: ({ request, params }) =>
		guard(async () => {
			const form = await request.formData();
			nodeOr404(params.id);
			const on = form.get('on') === '1';
			updateNode(params.id, { allowDownload: on });
			return {
				message: on ? 'Nedlasting av originaler er slått på.' : 'Nedlasting av originaler er slått av.'
			};
		}),

	/** Kan gruppa laste ned originaler? Gjelder alt som er delt med gruppa. */
	groupDownload: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const group = getGroup(str(form, 'group'));
			if (!group) throw new HttpError(404, 'Gruppa finnes ikke.');
			const on = form.get('on') === '1';
			updateGroup(group.id, { download: on ? 'yes' : 'no' });
			return {
				message: on ? `«${group.name}» kan laste ned originalene.` : `«${group.name}» kan ikke laste ned.`
			};
		}),

	groupExpiry: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const group = getGroup(str(form, 'group'));
			if (!group) throw new HttpError(404, 'Gruppa finnes ikke.');
			updateGroup(group.id, { expires: form.get('expires') });
			return {
				message: form.get('expires') ? 'Utløpsdatoen er lagret.' : 'Tilgangen varer uten slutt.'
			};
		}),

	addPerson: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const group = getGroup(str(form, 'group'));
			if (!group) throw new HttpError(404, 'Gruppa finnes ikke.');
			const guest = addMember(group.id, form.get('email'), form.get('name'));
			if (form.get('invite') === 'on') {
				await sendInvite(guest.id, url.origin);
				return { message: `La til ${guest.email} og sendte invitasjon.` };
			}
			return { message: `La til ${guest.email} i «${group.name}».` };
		}),

	removePerson: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			removeMember(str(form, 'group'), str(form, 'user'));
			return { message: 'Fjernet fra gruppa.' };
		}),

	sendLink: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const guest = await sendInvite(str(form, 'user'), url.origin);
			return { message: `Sendte ny lenke til ${guest.email}.` };
		}),

	copyLink: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const { guest, url: link } = inviteLink(str(form, 'user'), url.origin);
			return { link, email: guest.email };
		}),

	sortByDate: ({ params }) =>
		guard(() => {
			sortByTaken(params.id);
			return { message: 'Sortert etter dato tatt.' };
		})
};
