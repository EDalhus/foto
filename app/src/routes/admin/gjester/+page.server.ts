import { fail } from '@sveltejs/kit';
import {
	accessOf,
	addMember,
	createGroup,
	createLoginToken,
	deleteGroup,
	expiryDate,
	getGroup,
	getGuest,
	grantAccess,
	INVITE_LINK_DAYS,
	listGroups,
	membersOf,
	removeMember,
	revokeAccess,
	updateGroup
} from '$lib/server/guests';
import { loginMail, mailConfigured, sendMail } from '$lib/server/mail';
import { getTree, HttpError, type TreeNode } from '$lib/server/tree';
import type { Actions, PageServerLoad } from './$types';

/** Alle mapper og album som «Mappe / Album» – til nedtrekkslista for tilgang. */
function nodeOptions() {
	const out: { id: string; label: string; type: string }[] = [];
	const walk = (list: TreeNode[], prefix: string) => {
		for (const n of list) {
			const label = prefix ? `${prefix} / ${n.name}` : n.name;
			out.push({ id: n.id, label, type: n.type });
			walk(n.children, label);
		}
	};
	walk(getTree().roots, '');
	return out;
}

export const load: PageServerLoad = () => ({
	groups: listGroups().map((g) => ({
		...g,
		expiresDate: expiryDate(g.expires_at),
		expired: !!g.expires_at && g.expires_at <= Date.now(),
		members: membersOf(g.id),
		access: accessOf(g.id)
	})),
	nodes: nodeOptions(),
	mailReady: mailConfigured()
});

async function guard<T>(fn: () => Promise<T> | T) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof HttpError) return fail(err.status, { error: err.message });
		throw err;
	}
}

async function sendInvite(userId: string, origin: string) {
	const guest = getGuest(userId);
	if (!guest) throw new HttpError(404, 'Personen finnes ikke.');
	const { token } = createLoginToken(guest.id, 'invite');
	try {
		await sendMail(
			loginMail({ to: guest.email, name: guest.name, url: `${origin}/login/lenke/${token}`, invite: true, validFor: `${INVITE_LINK_DAYS} dager` })
		);
	} catch (err) {
		console.error('[foto] Kunne ikke sende invitasjon:', err);
		throw new HttpError(503, `Klarte ikke å sende e-post til ${guest.email}. Bruk «Kopier lenke» i stedet.`);
	}
	return guest;
}

export const actions: Actions = {
	createGroup: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const id = createGroup(form.get('name'), form.get('kind'));
			return { message: 'Gruppa er laget. Legg til personer og velg hva de skal se.', openGroup: id };
		}),

	updateGroup: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			updateGroup(String(form.get('group') ?? ''), {
				name: form.get('name'),
				kind: form.get('kind'),
				expires: form.get('expires'),
				download: form.get('download')
			});
			return { message: 'Lagret.' };
		}),

	deleteGroup: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const group = getGroup(String(form.get('group') ?? ''));
			if (!group) throw new HttpError(404, 'Gruppa finnes ikke.');
			deleteGroup(group.id);
			return { message: `Slettet «${group.name}».` };
		}),

	addMember: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const groupId = String(form.get('group') ?? '');
			const guest = addMember(groupId, form.get('email'), form.get('name'));
			if (form.get('invite') === 'on') {
				await sendInvite(guest.id, url.origin);
				return { message: `La til ${guest.email} og sendte invitasjon.`, openGroup: groupId };
			}
			return { message: `La til ${guest.email}.`, openGroup: groupId };
		}),

	removeMember: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			removeMember(String(form.get('group') ?? ''), String(form.get('user') ?? ''));
			return { message: 'Fjernet fra gruppa.' };
		}),

	invite: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const guest = await sendInvite(String(form.get('user') ?? ''), url.origin);
			return { message: `Sendte ny lenke til ${guest.email}.` };
		}),

	copyLink: ({ request, url }) =>
		guard(async () => {
			const form = await request.formData();
			const guest = getGuest(String(form.get('user') ?? ''));
			if (!guest) throw new HttpError(404, 'Personen finnes ikke.');
			const { token } = createLoginToken(guest.id, 'invite');
			return { link: { email: guest.email, url: `${url.origin}/login/lenke/${token}` } };
		}),

	grant: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			const groupId = String(form.get('group') ?? '');
			grantAccess(groupId, String(form.get('node') ?? ''));
			return { message: 'Tilgang gitt.', openGroup: groupId };
		}),

	revoke: ({ request }) =>
		guard(async () => {
			const form = await request.formData();
			revokeAccess(String(form.get('group') ?? ''), String(form.get('node') ?? ''));
			return { message: 'Tilgang fjernet.' };
		})
};
