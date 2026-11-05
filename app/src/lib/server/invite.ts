import { createLoginToken, getGuest, INVITE_LINK_DAYS } from './guests';
import { loginMail, sendMail } from './mail';
import { HttpError } from './tree';

/** Lenke som logger gjesten inn (gyldig i INVITE_LINK_DAYS dager, kan brukes én gang). */
export function inviteLink(userId: string, origin: string) {
	const guest = getGuest(userId);
	if (!guest) throw new HttpError(404, 'Personen finnes ikke.');
	const { token } = createLoginToken(guest.id, 'invite');
	return { guest, url: `${origin}/login/lenke/${token}` };
}

/** Sender en ny innloggingslenke på e-post. */
export async function sendInvite(userId: string, origin: string) {
	const { guest, url } = inviteLink(userId, origin);
	try {
		await sendMail(
			loginMail({
				to: guest.email,
				name: guest.name,
				url,
				invite: true,
				validFor: `${INVITE_LINK_DAYS} dager`
			})
		);
	} catch (err) {
		console.error('[foto] Kunne ikke sende invitasjon:', err);
		throw new HttpError(503, `Klarte ikke å sende e-post til ${guest.email}. Bruk «Kopier lenke» i stedet.`);
	}
	return guest;
}
