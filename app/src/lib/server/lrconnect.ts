/**
 * «Koble til Foto» fra Lightroom – uten å lime inn API-nøkkel.
 *
 * 1. Pluginen kaller /api/v1/connect/start og får en hemmelig henteverdi (pollSecret) og en kort kode.
 * 2. Pluginen åpner /koble/<kode> i nettleseren. Der logger brukeren inn og trykker «Koble til».
 * 3. Pluginen spør /api/v1/connect/poll med pollSecret til den får en ny API-nøkkel.
 *
 * Forespørslene holdes bare i minnet: de lever i 10 minutter, og en omstart betyr bare at man trykker på nytt.
 * Nøkkelen hentes én gang og glemmes deretter av serveren (bare hashen ligger i databasen).
 */
import { randomBytes } from 'node:crypto';
import { createApiToken } from './auth';
import { now, randomToken, sha256 } from './ids';

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
// Uten 0/O, 1/I/L og U, så koden er lett å sammenligne med det Lightroom viser.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export interface ConnectRequest {
	code: string;
	device: string;
	ip: string;
	createdAt: number;
	status: 'pending' | 'approved' | 'denied';
	token?: string;
	email?: string;
}

const bySecret = new Map<string, ConnectRequest>(); // nøkkel: sha256(pollSecret)
const byCode = new Map<string, string>(); // kode → sha256(pollSecret)

function purge() {
	const t = now();
	for (const [h, r] of bySecret) {
		if (t - r.createdAt > TTL_MS) {
			bySecret.delete(h);
			byCode.delete(r.code);
		}
	}
}

function newCode(): string {
	for (;;) {
		const b = randomBytes(8);
		let c = '';
		for (let i = 0; i < 8; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
		c = `${c.slice(0, 4)}-${c.slice(4)}`;
		if (!byCode.has(c)) return c;
	}
}

export function normalizeCode(code: string): string {
	const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
	return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : '';
}

export function cleanDevice(device: unknown): string {
	const d = typeof device === 'string' ? device.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
	return d.slice(0, 60) || 'ukjent maskin';
}

/** Starter en tilkobling. Returnerer null hvis det er for mange ventende (enkel bremse). */
export function startConnect(device: string, ip: string): { pollSecret: string; code: string; expiresIn: number } | null {
	purge();
	if (bySecret.size >= MAX_PENDING) return null;
	let fromIp = 0;
	for (const r of bySecret.values()) if (r.ip === ip && r.status === 'pending') fromIp++;
	if (fromIp >= 5) return null;
	const pollSecret = randomToken(32);
	const code = newCode();
	const h = sha256(pollSecret);
	bySecret.set(h, { code, device, ip, createdAt: now(), status: 'pending' });
	byCode.set(code, h);
	return { pollSecret, code, expiresIn: TTL_MS / 1000 };
}

export function findByCode(code: string): ConnectRequest | null {
	purge();
	const h = byCode.get(normalizeCode(code));
	return (h && bySecret.get(h)) || null;
}

/** Godkjenner: lager en API-nøkkel for brukeren som pluginen kan hente én gang. */
export function approve(code: string, user: { id: string; email: string }): ConnectRequest | null {
	const r = findByCode(code);
	if (!r || r.status !== 'pending') return null;
	const { token } = createApiToken(user.id, `Lightroom – ${r.device}`);
	r.status = 'approved';
	r.token = token;
	r.email = user.email;
	return r;
}

export function deny(code: string): boolean {
	const r = findByCode(code);
	if (!r || r.status !== 'pending') return false;
	r.status = 'denied';
	return true;
}

export type PollResult =
	| { status: 'pending' }
	| { status: 'approved'; token: string; email: string }
	| { status: 'denied' }
	| { status: 'expired' };

export function poll(pollSecret: string): PollResult {
	purge();
	const h = sha256(pollSecret);
	const r = bySecret.get(h);
	if (!r) return { status: 'expired' };
	if (r.status === 'pending') return { status: 'pending' };
	bySecret.delete(h);
	byCode.delete(r.code);
	if (r.status === 'approved') return { status: 'approved', token: r.token!, email: r.email! };
	return { status: 'denied' };
}
