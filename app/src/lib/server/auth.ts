import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { all, one, run } from './db';
import { config } from './config';
import { newId, now, randomToken, sha256 } from './ids';

const scrypt = promisify(scryptCb) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export type Role = 'admin' | 'viewer';
export interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: Role;
}

export const SESSION_COOKIE = 'foto_session';
export const SESSION_DAYS = 30;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(password, salt, 64, SCRYPT);
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	if (!stored) return false;
	const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
	if (scheme !== 'scrypt') return false;
	const expected = Buffer.from(hashB64, 'base64');
	const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
		maxmem: SCRYPT.maxmem
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Oppretter admin-brukeren fra ADMIN_EMAIL/ADMIN_PASSWORD hvis det ikke finnes noen admin. */
export async function ensureAdmin(): Promise<void> {
	const existing = one<{ n: number }>(`SELECT count(*) AS n FROM users WHERE role = 'admin'`);
	if (existing && existing.n > 0) return;
	if (!config.admin.email || !config.admin.password) {
		console.warn('[foto] Ingen admin-bruker finnes. Sett ADMIN_EMAIL og ADMIN_PASSWORD og start på nytt.');
		return;
	}
	run(
		`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, '', 'admin', ?, ?)`,
		newId(),
		config.admin.email.trim(),
		await hashPassword(config.admin.password),
		now()
	);
	console.log(`[foto] Opprettet admin-bruker ${config.admin.email}`);
}

export function findUserByEmail(email: string) {
	return one<SessionUser & { password_hash: string | null }>(
		`SELECT id, email, name, role, password_hash FROM users WHERE email = ?`,
		email.trim()
	);
}

export function createSession(userId: string): { token: string; expires: Date } {
	const token = randomToken();
	const expires = now() + SESSION_DAYS * 86400_000;
	run(
		`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		sha256(token),
		userId,
		now(),
		expires
	);
	return { token, expires: new Date(expires) };
}

export function userFromSession(token: string | undefined): SessionUser | null {
	if (!token) return null;
	const row = one<SessionUser & { expires_at: number }>(
		`SELECT u.id, u.email, u.name, u.role, s.expires_at
		 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
		sha256(token)
	);
	if (!row) return null;
	if (row.expires_at < now()) {
		run(`DELETE FROM sessions WHERE id = ?`, sha256(token));
		return null;
	}
	return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function deleteSession(token: string | undefined) {
	if (token) run(`DELETE FROM sessions WHERE id = ?`, sha256(token));
}

export function purgeExpiredSessions() {
	run(`DELETE FROM sessions WHERE expires_at < ?`, now());
}

// --- API-nøkler (brukes av Lightroom-pluginen) ---

export interface ApiTokenInfo {
	id: string;
	name: string;
	prefix: string;
	created_at: number;
	last_used_at: number | null;
}

export function createApiToken(userId: string, name: string): { token: string; info: ApiTokenInfo } {
	const token = `fto_${randomToken(30)}`;
	const info: ApiTokenInfo = {
		id: newId(),
		name: name.trim() || 'Uten navn',
		prefix: token.slice(0, 10),
		created_at: now(),
		last_used_at: null
	};
	run(
		`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		info.id,
		userId,
		info.name,
		sha256(token),
		info.prefix,
		info.created_at
	);
	return { token, info };
}

export function listApiTokens(userId: string): ApiTokenInfo[] {
	return all<ApiTokenInfo>(
		`SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
		userId
	);
}

export function deleteApiToken(userId: string, id: string) {
	run(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`, id, userId);
}

export function userFromApiToken(token: string): SessionUser | null {
	if (!token.startsWith('fto_')) return null;
	const hash = sha256(token);
	const row = one<SessionUser & { token_id: string; last_used_at: number | null }>(
		`SELECT u.id, u.email, u.name, u.role, t.id AS token_id, t.last_used_at
		 FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
		hash
	);
	if (!row) return null;
	// Oppdater «sist brukt» maks én gang i minuttet for å spare skriving.
	if (!row.last_used_at || now() - row.last_used_at > 60_000) {
		run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now(), row.token_id);
	}
	return { id: row.id, email: row.email, name: row.name, role: row.role };
}

// --- Enkel bremse på innloggingsforsøk (per IP, i minnet) ---

const attempts = new Map<string, { count: number; reset: number }>();

export function loginAllowed(ip: string): boolean {
	const entry = attempts.get(ip);
	if (!entry || entry.reset < now()) return true;
	return entry.count < 10;
}

export function recordLoginFailure(ip: string) {
	const entry = attempts.get(ip);
	if (!entry || entry.reset < now()) attempts.set(ip, { count: 1, reset: now() + 15 * 60_000 });
	else entry.count++;
	if (attempts.size > 10_000) attempts.clear();
}

export function clearLoginFailures(ip: string) {
	attempts.delete(ip);
}
