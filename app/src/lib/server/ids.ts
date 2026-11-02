import { createHash, randomBytes } from 'node:crypto';

// Crockford base32 uten tegn som kan forveksles (i, l, o, u).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Tilfeldig, URL-vennlig ID (12 tegn ≈ 60 bit). */
export function newId(length = 12): string {
	const bytes = randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
	return out;
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export const isId = (value: unknown): value is string =>
	typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{6,32}$/.test(value);

export const now = () => Date.now();
