/**
 * Gjester (v2 familie og venner, v3 kunder).
 *
 * En gjest er en bruker med rollen «viewer». Gjester er med i én eller flere grupper, og en gruppe får
 * tilgang til mapper og album. Tilgang til en mappe gjelder alt under den. Gjester logger inn med en
 * lenke på e-post – de har aldri passord.
 */
import { all, one, run, tx } from './db';
import { newId, now, randomToken, sha256 } from './ids';
import { getNode, HttpError, invalidate, pathOf } from './tree';

export type GroupKind = 'family' | 'client';

export const LOGIN_LINK_MINUTES = 30;
export const INVITE_LINK_DAYS = 14;

export interface GroupRow {
	id: string;
	name: string;
	kind: GroupKind;
	created_at: number;
}

export interface GuestRow {
	id: string;
	email: string;
	name: string;
	last_login_at: number | null;
	created_at: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(value: unknown): string {
	const email = String(value ?? '').trim().toLowerCase();
	if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'Skriv inn en gyldig e-postadresse.');
	return email;
}

function cleanText(value: unknown, what: string, max = 100, required = true): string {
	const s = String(value ?? '').replace(/\s+/g, ' ').trim();
	if (required && !s) throw new HttpError(400, `${what} mangler.`);
	if (s.length > max) throw new HttpError(400, `${what} er for langt (maks ${max} tegn).`);
	return s;
}

const kindOf = (value: unknown): GroupKind => (value === 'client' ? 'client' : 'family');

// --- Grupper ---

export function createGroup(name: unknown, kind: unknown): string {
	const id = newId();
	run(`INSERT INTO groups (id, name, kind, created_at) VALUES (?, ?, ?, ?)`, id, cleanText(name, 'Navn'), kindOf(kind), now());
	return id;
}

export function updateGroup(id: string, name: unknown, kind: unknown) {
	if (!getGroup(id)) throw new HttpError(404, 'Gruppa finnes ikke.');
	run(`UPDATE groups SET name = ?, kind = ? WHERE id = ?`, cleanText(name, 'Navn'), kindOf(kind), id);
}

/** Sletter gruppa. Gjester som da ikke er med i noen gruppe, slettes også (de har ingenting å se). */
export function deleteGroup(id: string) {
	tx(() => {
		const members = all<{ user_id: string }>(`SELECT user_id FROM group_members WHERE group_id = ?`, id).map((r) => r.user_id);
		run(`DELETE FROM groups WHERE id = ?`, id);
		for (const userId of members) deleteGuestIfOrphan(userId);
		invalidate();
	});
}

export function getGroup(id: string): GroupRow | undefined {
	return one<GroupRow>(`SELECT * FROM groups WHERE id = ?`, id);
}

export function listGroups(): GroupRow[] {
	return all<GroupRow>(`SELECT * FROM groups ORDER BY kind DESC, name COLLATE NOCASE`);
}

// --- Medlemmer ---

/** Legger til en person i gruppa. Lager gjesten hvis e-posten er ny. */
export function addMember(groupId: string, emailValue: unknown, nameValue: unknown): GuestRow {
	const email = cleanEmail(emailValue);
	const name = cleanText(nameValue, 'Navn', 100, false);
	return tx(() => {
		if (!getGroup(groupId)) throw new HttpError(404, 'Gruppa finnes ikke.');
		let user = one<GuestRow & { role: string }>(`SELECT id, email, name, role, last_login_at, created_at FROM users WHERE email = ?`, email);
		if (user && user.role !== 'viewer') throw new HttpError(400, 'Den adressen tilhører en administrator.');
		if (!user) {
			const id = newId();
			run(`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'viewer', NULL, ?)`, id, email, name, now());
			user = { id, email, name, role: 'viewer', last_login_at: null, created_at: now() };
		} else if (name && name !== user.name) {
			run(`UPDATE users SET name = ? WHERE id = ?`, name, user.id);
			user.name = name;
		}
		run(`INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?, ?, ?)`, groupId, user.id, now());
		invalidate();
		return { id: user.id, email: user.email, name: user.name, last_login_at: user.last_login_at, created_at: user.created_at };
	});
}

export function removeMember(groupId: string, userId: string) {
	tx(() => {
		run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, groupId, userId);
		deleteGuestIfOrphan(userId);
		invalidate();
	});
}

/** En gjest uten grupper slettes, sammen med øktene og lenkene sine. */
function deleteGuestIfOrphan(userId: string) {
	const inGroup = one(`SELECT 1 FROM group_members WHERE user_id = ?`, userId);
	if (!inGroup) run(`DELETE FROM users WHERE id = ? AND role = 'viewer'`, userId);
}

export function getGuest(id: string): GuestRow | undefined {
	return one<GuestRow>(`SELECT id, email, name, last_login_at, created_at FROM users WHERE id = ? AND role = 'viewer'`, id);
}

export function findGuestByEmail(email: string): GuestRow | undefined {
	return one<GuestRow>(`SELECT id, email, name, last_login_at, created_at FROM users WHERE email = ? AND role = 'viewer'`, email.trim());
}

export function membersOf(groupId: string): GuestRow[] {
	return all<GuestRow>(
		`SELECT u.id, u.email, u.name, u.last_login_at, u.created_at FROM group_members m JOIN users u ON u.id = m.user_id
		 WHERE m.group_id = ? ORDER BY u.name COLLATE NOCASE, u.email`,
		groupId
	);
}

// --- Tilgang ---

export function groupIdsWithAccess(nodeId: string): string[] {
	return all<{ group_id: string }>(`SELECT group_id FROM node_access WHERE node_id = ?`, nodeId).map((r) => r.group_id);
}

/** Setter nøyaktig hvilke grupper som har tilgang til noden. */
export function setAccess(nodeId: string, groupIds: string[]) {
	tx(() => {
		if (!getNode(nodeId)) throw new HttpError(404, 'Finnes ikke.');
		const valid = new Set(listGroups().map((g) => g.id));
		run(`DELETE FROM node_access WHERE node_id = ?`, nodeId);
		for (const g of new Set(groupIds)) {
			if (valid.has(g)) run(`INSERT INTO node_access (node_id, group_id, created_at) VALUES (?, ?, ?)`, nodeId, g, now());
		}
		invalidate();
	});
}

export function grantAccess(groupId: string, nodeId: string) {
	if (!getGroup(groupId)) throw new HttpError(404, 'Gruppa finnes ikke.');
	if (!getNode(nodeId)) throw new HttpError(404, 'Mappa eller albumet finnes ikke.');
	run(`INSERT OR IGNORE INTO node_access (node_id, group_id, created_at) VALUES (?, ?, ?)`, nodeId, groupId, now());
	invalidate();
}

export function revokeAccess(groupId: string, nodeId: string) {
	run(`DELETE FROM node_access WHERE node_id = ? AND group_id = ?`, nodeId, groupId);
	invalidate();
}

/** Det gruppa har tilgang til, med sti til visning i admin. */
export function accessOf(groupId: string): { id: string; name: string; path: string; type: string }[] {
	return all<{ node_id: string }>(`SELECT node_id FROM node_access WHERE group_id = ?`, groupId)
		.map((r) => getNode(r.node_id))
		.filter((n): n is NonNullable<typeof n> => !!n)
		.map((n) => ({ id: n.id, name: n.name, path: pathOf(n), type: n.type }))
		.sort((a, b) => a.path.localeCompare(b.path, 'nb'));
}

/** Grupper som har tilgang via en mappe over noden (arvet). */
export function inheritedAccess(nodeId: string): { groupId: string; via: string }[] {
	const node = getNode(nodeId);
	const out: { groupId: string; via: string }[] = [];
	for (let p = node?.parent ?? null; p; p = p.parent) {
		for (const g of groupIdsWithAccess(p.id)) out.push({ groupId: g, via: p.name });
	}
	return out;
}

// --- Innloggingslenker ---

/** Lager en lenke som logger gjesten inn. Bare hashen lagres. */
export function createLoginToken(userId: string, purpose: 'login' | 'invite'): { token: string; expires: number } {
	const token = randomToken(32);
	const expires = now() + (purpose === 'invite' ? INVITE_LINK_DAYS * 86400_000 : LOGIN_LINK_MINUTES * 60_000);
	run(`DELETE FROM login_tokens WHERE expires_at < ?`, now());
	run(`INSERT INTO login_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, sha256(token), userId, purpose, now(), expires);
	return { token, expires };
}

/** Ser på en lenke uten å bruke den opp (til bekreftelsessiden). */
export function peekLoginToken(token: string): (GuestRow & { purpose: string }) | null {
	const row = one<GuestRow & { purpose: string; expires_at: number }>(
		`SELECT u.id, u.email, u.name, u.last_login_at, u.created_at, t.purpose, t.expires_at
		 FROM login_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND u.role = 'viewer'`,
		sha256(token)
	);
	if (!row || row.expires_at < now()) return null;
	return row;
}

/** Bruker opp lenken. Returnerer gjestens id, eller null hvis lenken er ugyldig eller utløpt. */
export function consumeLoginToken(token: string): string | null {
	return tx(() => {
		const row = peekLoginToken(token);
		run(`DELETE FROM login_tokens WHERE id = ?`, sha256(token));
		if (!row) return null;
		run(`UPDATE users SET last_login_at = ? WHERE id = ?`, now(), row.id);
		return row.id;
	});
}

// --- Bremse på utsending av lenker (i minnet) ---

const sends = new Map<string, number[]>();

/** Maks `limit` lenker per nøkkel (IP eller e-post) per kvarter. */
export function linkSendAllowed(key: string, limit: number): boolean {
	const t = now();
	const list = (sends.get(key) ?? []).filter((x) => t - x < 15 * 60_000);
	if (list.length >= limit) {
		sends.set(key, list);
		return false;
	}
	list.push(t);
	sends.set(key, list);
	if (sends.size > 10_000) sends.clear();
	return true;
}
