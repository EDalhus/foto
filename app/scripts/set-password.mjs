#!/usr/bin/env node
/**
 * Setter nytt passord for en admin-bruker (eller oppretter brukeren hvis den ikke finnes),
 * og logger ut alle innloggede økter for brukeren.
 *
 * På serveren (fra din egen Terminal, så passordet aldri havner noe annet sted):
 *   ssh -t <server> 'cd /opt/foto && docker compose exec foto node scripts/set-password.mjs <e-post>'
 *
 * Lokalt:  DATA_DIR=./data node scripts/set-password.mjs deg@example.com
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import readline from 'node:readline';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }; // samme som src/lib/server/auth.ts
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

const email = (process.argv[2] || '').trim();
if (!email.includes('@')) {
	console.error('Bruk: node scripts/set-password.mjs <e-post>');
	process.exit(1);
}

/** Leser to linjer: skjult når det er en terminal, ellers fra stdin (for skript). */
async function readPasswords() {
	if (!process.stdin.isTTY) {
		const lines = [];
		const rl = readline.createInterface({ input: process.stdin });
		for await (const line of rl) lines.push(line);
		return [lines[0] ?? '', lines[1] ?? lines[0] ?? ''];
	}
	const ask = (q) =>
		new Promise((resolve) => {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
			rl._writeToOutput = (s) => {
				if (s.startsWith(q)) process.stdout.write(q);
			};
			rl.question(q, (answer) => {
				rl.close();
				process.stdout.write('\n');
				resolve(answer);
			});
		});
	const a = await ask('Nytt passord (minst 12 tegn): ');
	const b = await ask('Gjenta passordet: ');
	return [a, b];
}

const [password, repeat] = await readPasswords();
if (password.length < 12) {
	console.error('Passordet må ha minst 12 tegn. Ingenting er endret.');
	process.exit(1);
}
if (password !== repeat) {
	console.error('Passordene er ikke like. Ingenting er endret.');
	process.exit(1);
}

const salt = randomBytes(16);
const hash = await scrypt(password, salt, 64, SCRYPT);
const stored = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;

const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || './data'), 'foto.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const user = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
if (user) {
	db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(stored, user.id);
	const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
	const n = Number(changes);
	console.log(`Passordet for ${email} er byttet. ${n === 0 ? 'Ingen var innlogget.' : `${n} ${n === 1 ? 'økt' : 'økter'} ble logget ut.`}`);
} else {
	const bytes = randomBytes(12);
	let id = '';
	for (let i = 0; i < 12; i++) id += ALPHABET[bytes[i] & 31];
	db.prepare(
		`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, '', 'admin', ?, ?)`
	).run(id, email, stored, Date.now());
	console.log(`Opprettet admin-bruker ${email}.`);
}
db.close();
