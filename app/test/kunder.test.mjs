// Ende-til-ende-test av «velg N bilder», låst valg, påminnelse før tilgangen går ut og statistikk.
//
//   cd app && npm run build && node test/kunder.test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-kunder-'));
const ADMIN = { email: 'admin@example.com', password: crypto.randomBytes(12).toString('hex') };

let failures = 0;
const check = (cond, msg) => {
	console.log(`  ${cond ? 'ok  ' : 'FEIL'}  ${msg}`);
	if (!cond) failures++;
};

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

// --- Falsk SMTP-server ---------------------------------------------------------------------
const mails = [];
const smtp = net.createServer((sock) => {
	let data = false;
	let buf = '';
	let current = { to: '', body: '' };
	sock.write('220 test ESMTP\r\n');
	sock.on('data', (chunk) => {
		buf += chunk.toString('utf8');
		let i;
		while ((i = buf.indexOf('\r\n')) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 2);
			if (data) {
				if (line === '.') {
					data = false;
					mails.push(current);
					current = { to: '', body: '' };
					sock.write('250 OK\r\n');
				} else current.body += line + '\n';
				continue;
			}
			const cmd = line.slice(0, 4).toUpperCase();
			if (cmd === 'EHLO') sock.write('250-test\r\n250 8BITMIME\r\n');
			else if (cmd === 'HELO') sock.write('250 test\r\n');
			else if (cmd === 'RCPT') {
				current.to = line.match(/<([^>]+)>/)?.[1] ?? '';
				sock.write('250 OK\r\n');
			} else if (cmd === 'DATA') {
				data = true;
				sock.write('354 go\r\n');
			} else if (cmd === 'QUIT') {
				sock.write('221 bye\r\n');
				sock.end();
			} else sock.write('250 OK\r\n');
		}
	});
});
const SMTP_PORT = await freePort();
await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

// Lenken i siste e-post til en adresse (quoted-printable kan bryte linjer).
function linkFor(email) {
	const m = [...mails].reverse().find((x) => x.to === email);
	if (!m) return null;
	const body = m.body.replace(/=\n/g, '').replace(/=3D/g, '=');
	return body.match(/https?:\/\/[^\s"<]+\/login\/lenke\/[A-Za-z0-9_-]+(\?next=[^\s"<]*)?/)?.[0] ?? null;
}

// --- Server ----------------------------------------------------------------------------------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn('node', [path.join(APP, 'build/index.js')], {
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: String(PORT),
		ORIGIN: BASE,
		DATA_DIR: path.join(WORK, 'data'),
		ADMIN_EMAIL: ADMIN.email,
		ADMIN_PASSWORD: ADMIN.password,
		STORAGE_DRIVER: 'local',
		SMTP_HOST: '127.0.0.1',
		SMTP_PORT: String(SMTP_PORT),
		MAIL_FROM: 'Test <noreply@example.com>',
		NODE_NO_WARNINGS: '1',
		REMINDER_FIRST_MS: '400',
		REMINDER_INTERVAL_MS: '400'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const cleanup = () => {
	server.kill();
	smtp.close();
	fs.rmSync(WORK, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`${BASE}/health`)).ok) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 100));
}
const db = () => new DatabaseSync(path.join(WORK, 'data/foto.db'), { readOnly: true });
const q = (sql, ...p) => {
	const d = db();
	try {
		return d.prepare(sql).all(...p);
	} finally {
		d.close();
	}
};

// --- En enkel «nettleser» med egen cookie ---------------------------------------------------
class Browser {
	cookie = '';
	async req(method, url, { form, body, headers = {} } = {}) {
		const h = { Origin: BASE, ...headers };
		if (this.cookie) h.Cookie = this.cookie;
		let payload = body;
		if (form) {
			payload = new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])));
			h['content-type'] = 'application/x-www-form-urlencoded';
		}
		const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
		const set = res.headers.getSetCookie?.() ?? [];
		for (const c of set) {
			const [pair] = c.split(';');
			if (pair.startsWith('foto_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
		}
		const text = await res.text();
		return { status: res.status, location: res.headers.get('location'), text };
	}
	get(url) {
		return this.req('GET', url);
	}
	post(url, form) {
		return this.req('POST', url, { form, headers: { accept: 'text/html' } });
	}
	/** SvelteKit-handling som JSON (som use:enhance). */
	async action(url, form) {
		const r = await this.req('POST', url, { form, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
		let data = null;
		try {
			const j = JSON.parse(r.text);
			data = j.data ? devalue(j.data) : null;
			return { ...r, type: j.type, data };
		} catch {
			return { ...r, type: 'html', data };
		}
	}
}
// SvelteKit sender handlingsdata «devalue»-kodet: [rot, ...verdier] der tall er indekser.
function devalue(s) {
	const arr = JSON.parse(s);
	const hyd = (i) => {
		const v = arr[i];
		if (Array.isArray(v)) return v.map(hyd);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hyd(x)]));
		return v;
	};
	return hyd(0);
}


const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const mailsTo = (to) => mails.filter((m) => m.to === to);
const decoded = (m) => m.body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const osloDate = (offsetDays) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(Date.now() + offsetDays * 86400_000);

// --- Oppsett ---------------------------------------------------------------------------------
console.log('1. Oppsett');
const admin = new Browser();
await admin.post('/login?/password', { email: ADMIN.email, password: ADMIN.password });
const node = (slug) => q('SELECT id FROM nodes WHERE slug = ?', slug)[0]?.id;
await admin.post('/admin?/create', { name: 'Bryllup', type: 'album', visibility: 'private' });
await admin.post('/admin?/create', { name: 'Fjordtur', type: 'album', visibility: 'public', allowDownload: 'on' });
const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#557788' } }).jpeg().toBuffer();
async function upload(slug, filename) {
	const fd = new FormData();
	fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), filename);
	const r = await fetch(`${BASE}/api/v1/albums/${node(slug)}/photos`, { method: 'POST', body: fd, headers: { Origin: BASE, Cookie: admin.cookie } });
	return (await r.json()).id;
}
const p = [];
for (let i = 1; i <= 4; i++) p.push(await upload('bryllup', `IMG_000${i}.jpg`));
const pub = await upload('fjordtur', 'IMG_0100.jpg');
const A = (action) => `/admin/node/${node('bryllup')}?/${action}`;
await admin.action(A('newClient'), { name: 'Ola Hansen', email: 'ola@example.com' });
const client = q(`SELECT * FROM groups WHERE kind = 'client'`)[0];
const olaId = q(`SELECT id FROM users WHERE email = 'ola@example.com'`)[0].id;
const ola = new Browser();
const link = await admin.action(A('copyLink'), { user: olaId });
await ola.post(String(link.data.link).replace(BASE, ''), {});
check(!!ola.cookie && (await ola.get('/bryllup')).status === 200, 'kunden er logget inn og ser albumet');
const fav = (b, photo, on) => b.req('POST', '/api/v1/favorites', { body: JSON.stringify({ photo, on }), headers: { 'content-type': 'application/json' } });

// --- Velg N bilder -----------------------------------------------------------------------------
console.log('2. «Velg N bilder»');
let r = await admin.action(A('pickCount'), { count: '2' });
check(r.type === 'success' && q('SELECT pick_count FROM nodes WHERE id = ?', node('bryllup'))[0].pick_count === 2, 'antall lagret på albumet');
check((await admin.action(A('pickCount'), { count: '0' })).type === 'failure', 'ugyldig antall avvises');
check((await fav(ola, p[0], true)).status === 200 && (await fav(ola, p[1], true)).status === 200, 'velger to bilder');
const third = await fav(ola, p[2], true);
check(third.status === 409 && /2 av 2/.test(third.text), 'det tredje avvises (2 av 2)');
check((await fav(ola, p[0], true)).status === 200, 'å velge et bilde som allerede er valgt, går fint');
check((await fav(ola, p[1], false)).status === 200 && (await fav(ola, p[2], true)).status === 200, 'fjern ett og velg et annet');
const page = await ola.get('/bryllup');
check(page.text.replace(/<!--[^]*?-->/g, '').includes('2 av 2 valgt'), 'kunden ser «2 av 2 valgt»');

// --- Låst etter sending ------------------------------------------------------------------------
console.log('3. Låst valg');
const before = mails.length;
r = await ola.action('/bryllup?/sendFavorites', {});
await wait(300);
check(r.type === 'success' && q('SELECT locked_at FROM favorite_submissions')[0].locked_at > 0, 'valget sendt og låst');
const notice = mails.slice(before).find((m) => m.to === ADMIN.email);
// Quoted-printable er UTF-8-bytes: dekod bytene, så teksten.
const utf8 = (m) => Buffer.from(decoded(m), 'latin1').toString('utf8');
check(notice && /2 av 2/.test(utf8(notice)) && /Valget er låst/.test(utf8(notice)), 'e-posten til deg sier «2 av 2» og at valget er låst');
const locked = await fav(ola, p[3], true);
check(locked.status === 423, 'hjertet er låst etter sending');
check((await fav(ola, p[0], false)).status === 423 && q('SELECT count(*) AS n FROM favorites')[0].n === 2, 'kan heller ikke fjerne bilder');
check((await ola.action('/bryllup?/sendFavorites', {})).type === 'failure', 'kan ikke sende på nytt mens det er låst');
const lockedPage = (await ola.get('/bryllup')).text;
check(lockedPage.includes('Valget er sendt') && !lockedPage.includes('Send valget'), 'kunden ser «Valget er sendt»');
let adminPage = (await admin.get(`/admin/node/${node('bryllup')}`)).text;
check(adminPage.includes('Lås opp') && adminPage.includes('2 av 2'), 'albumsiden i admin viser «2 av 2» og «Lås opp»');
r = await admin.action(A('unlockFavorites'), { user: olaId });
check(r.type === 'success' && q('SELECT locked_at FROM favorite_submissions')[0].locked_at === null, 'låst opp');
check((await fav(ola, p[0], false)).status === 200 && (await fav(ola, p[3], true)).status === 200, 'kunden kan endre valget igjen');
r = await ola.action('/bryllup?/sendFavorites', {});
check(r.type === 'success' && q('SELECT locked_at FROM favorite_submissions')[0].locked_at > 0, 'sendt på nytt: låst igjen');
check((await admin.action(A('unlockFavorites'), { user: 'finnes-ikke' })).type === 'failure', 'låse opp noe som ikke er låst, avvises');

// --- Påminnelse før tilgangen går ut -------------------------------------------------------------
console.log('4. Påminnelse');
const olaMails = () => mailsTo('ola@example.com').filter((m) => /tilgjengelige til og med/.test(decoded(m)));
await admin.action(A('groupExpiry'), { group: client.id, expires: osloDate(30) });
await wait(1200);
check(olaMails().length === 0, 'ingen påminnelse når det er lenge til');
await admin.action(A('groupExpiry'), { group: client.id, expires: osloDate(1) });
await wait(1500);
const reminders = olaMails();
check(reminders.length === 1, 'påminnelse sendt når det er under 3 dager igjen');
const body = reminders[0] ? decoded(reminders[0]) : '';
check(/Bryllup/.test(body) && /\/login\/lenke\/[A-Za-z0-9_-]+\?next=%2Fbryllup/.test(body.replace(/=\n/g, '')), 'e-posten nevner albumet og har lenke rett inn');
check(q('SELECT reminded_at FROM groups WHERE id = ?', client.id)[0].reminded_at > 0, 'merket som sendt');
await wait(1200);
check(olaMails().length === 1, 'bare én påminnelse per dato');
const remLink = body.replace(/=\n/g, '').match(/https?:\/\/[^\s"<]+\/login\/lenke\/[A-Za-z0-9_-]+\?next=[^\s"<]+/)?.[0];
const remB = new Browser();
const used = remLink ? await remB.post(remLink.replace(BASE, ''), {}) : null;
check(used?.status === 303 && used.location === '/bryllup', 'lenken i påminnelsen logger inn og går til albumet');
await admin.action(A('groupExpiry'), { group: client.id, expires: osloDate(2) });
check(q('SELECT reminded_at FROM groups WHERE id = ?', client.id)[0].reminded_at === null, 'ny dato: klar for ny påminnelse');
r = await admin.action('/admin/innstillinger?/reminders', { days: '3' });
check(r.type === 'success' && JSON.parse(q(`SELECT value FROM settings WHERE key = 'reminders'`)[0].value).enabled === false, 'påminnelser kan slås av');
await wait(1200);
check(olaMails().length === 1, 'avslått: ingen ny påminnelse');
r = await admin.action('/admin/innstillinger?/reminders', { enabled: 'on', days: '3' });
await wait(1500);
check(olaMails().length === 2, 'slått på igjen: påminnelse for den nye datoen');
check((await admin.action('/admin/innstillinger?/reminders', { enabled: 'on', days: '99' })).type === 'failure', 'ugyldig antall dager avvises');
await admin.action(A('groupExpiry'), { group: client.id, expires: '' });

// --- Statistikk --------------------------------------------------------------------------------
console.log('5. Statistikk');
const UA = 'Mozilla/5.0 (Macintosh) Safari/605.1.15';
const view = (b, id, ua = UA) => b.req('POST', '/api/v1/stats/view', { body: JSON.stringify({ node: id }), headers: { 'content-type': 'application/json', 'user-agent': ua } });
const stat = (id) => q('SELECT coalesce(sum(views),0) AS v, coalesce(sum(downloads),0) AS d, coalesce(sum(zips),0) AS z FROM node_stats WHERE node_id = ?', id)[0];
const anon = new Browser();
check((await view(anon, node('fjordtur'))).status === 204 && stat(node('fjordtur')).v === 1, 'besøkende: visning telt');
await view(anon, node('fjordtur'));
check(stat(node('fjordtur')).v === 1, 'samme besøkende telles én gang per halvtime');
await view(anon, node('fjordtur'), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130');
check(stat(node('fjordtur')).v === 2, 'en annen nettleser telles for seg');
await view(anon, node('fjordtur'), 'facebookexternalhit/1.1');
await view(anon, node('fjordtur'), 'Googlebot/2.1');
check(stat(node('fjordtur')).v === 2, 'roboter og lenkeforhåndsvisning telles ikke');
await view(admin, node('fjordtur'));
check(stat(node('fjordtur')).v === 2, 'du selv telles ikke');
check((await view(anon, node('bryllup'))).status === 404 && stat(node('bryllup')).v === 0, 'private album kan ikke telles av andre');
check((await view(ola, node('bryllup'))).status === 204 && stat(node('bryllup')).v === 1, 'kunden: visning telt');
const act = () => q('SELECT * FROM guest_activity WHERE user_id = ? AND node_id = ?', olaId, node('bryllup'))[0];
check(act()?.views === 1, 'kundens visning lagret på kunden');
await admin.action(A('groupDownload'), { group: client.id, on: '1' });
check((await ola.get(`/download/photo/${p[0]}`)).status === 200 && stat(node('bryllup')).d === 1 && act().downloads === 1, 'nedlasting av et bilde telt (også på kunden)');
await ola.req('GET', `/download/photo/${p[0]}`, { headers: { range: 'bytes=100-' } });
check(stat(node('bryllup')).d === 1, 'en fortsatt nedlasting telles ikke på nytt');
check((await ola.get(`/download/album/${node('bryllup')}`)).status === 200 && stat(node('bryllup')).z === 1 && act().zips === 1, 'hele albumet som zip telt');
await admin.get(`/download/photo/${p[1]}`);
check(stat(node('bryllup')).d === 1, 'dine egne nedlastinger telles ikke');
check(q('SELECT 1 FROM node_stats WHERE day = ?', osloDate(0)).length > 0, 'lagret på dagens dato (norsk tid)');
const statsPage = await admin.get('/admin/statistikk?periode=7');
const sp = statsPage.text.replace(/<!--[^]*?-->/g, '');
check(statsPage.status === 200 && sp.includes('Fjordtur') && sp.includes('Bryllup') && sp.includes('Ola Hansen'), 'statistikksiden viser albumene og kunden');
adminPage = (await admin.get(`/admin/node/${node('bryllup')}`)).text.replace(/<!--[^]*?-->/g, '');
check(adminPage.includes('Har sett albumet én gang') && adminPage.includes('lastet ned 1 bilde'), 'kundekortet viser hva kunden har sett og lastet ned');
check((await ola.get('/admin/statistikk')).status === 403 && (await new Browser().get('/admin/statistikk')).status === 303, 'statistikken er bare for deg');
check(!/ExperimentalWarning/.test('') && !/Error:/.test(serverLog), 'ingen feil i serverloggen');

console.log(`\nRESULTAT: ${failures} feil`);
process.exit(failures ? 1 : 0);
