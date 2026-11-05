// Ende-til-ende-test av adminsidene: forsidebilde, tilgang (offentlig / privat / kunde), grupper og kunder
// rett fra albumet, «Om albumet» og handlinger på flere album i biblioteket.
//
//   cd app && npm run build && node test/admin.test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-admin-'));
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
		NODE_NO_WARNINGS: '1'
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
			// Lister blir flere felt med samme navn (som flere avkrysningsbokser i et skjema).
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
check(!!admin.cookie, 'admin logget inn');
const node = (slug) => q('SELECT id FROM nodes WHERE slug = ?', slug)[0]?.id;
const row = (id) => q('SELECT * FROM nodes WHERE id = ?', id)[0];
await admin.post('/admin?/create', { name: 'Bryllup', type: 'album', visibility: 'public' });
await admin.post('/admin?/create', { name: 'Familie', type: 'folder', visibility: 'public' });
await admin.post('/admin?/create', { name: 'Jul', type: 'album', parentId: node('familie'), visibility: 'public' });
await admin.post('/admin?/create', { name: 'Sommer', type: 'album', parentId: node('familie'), visibility: 'public' });
await admin.post('/admin?/create', { name: 'Arkiv', type: 'folder', visibility: 'public' });
const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#557788' } }).jpeg().toBuffer();
async function upload(slug, filename) {
	const fd = new FormData();
	fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), filename);
	const r = await fetch(`${BASE}/api/v1/albums/${node(slug)}/photos`, { method: 'POST', body: fd, headers: { Origin: BASE, Cookie: admin.cookie } });
	return (await r.json()).id;
}
const b1 = await upload('bryllup', 'IMG_0001.jpg');
const b2 = await upload('bryllup', 'IMG_0002.jpg');
const j1 = await upload('jul', 'IMG_0101.jpg');
const s1 = await upload('sommer', 'IMG_0201.jpg');
check(b1 && b2 && j1 && s1, 'album og bilder laget');
const A = (slug, action) => `/admin/node/${node(slug)}?/${action}`;

// --- Forsidebilde ----------------------------------------------------------------------------
console.log('2. Forsidebilde');
let r = await admin.action(A('bryllup', 'setCover'), { photo: b2 });
check(r.type === 'success' && row(node('bryllup')).cover_photo_id === b2, 'velger forsidebilde i albumet');
check((await new Browser().get('/')).text.includes(`/media/${b2}/`), 'forsiden bruker det valgte bildet');
r = await admin.action(A('bryllup', 'setCover'), { photo: j1 });
check(r.type === 'failure' && row(node('bryllup')).cover_photo_id === b2, 'bilde fra et annet album avvises');
r = await admin.action(A('familie', 'setCover'), { photo: s1 });
check(r.type === 'success' && row(node('familie')).cover_photo_id === s1, 'mappe: forsidebilde fra et album i mappa');
r = await admin.action(A('familie', 'setCover'), { photo: b1 });
check(r.type === 'failure', 'mappe: bilde utenfor mappa avvises');
r = await admin.action(A('bryllup', 'setCover'), { photo: '' });
check(r.type === 'success' && row(node('bryllup')).cover_photo_id === null, '«Velg automatisk» fjerner valget');
const opts = await admin.get(`/admin/node/${node('familie')}/forside`);
const sections = JSON.parse(opts.text).sections;
check(opts.status === 200 && sections.length === 2 && sections.some((s) => s.photos.some((p) => p.id === j1)), 'bildevelgeren for mappa viser bildene i albumene');
check((await new Browser().get(`/admin/node/${node('familie')}/forside`)).status === 401, 'bildevelgeren krever innlogging');
const api = (b, id, body) => b.req('POST', `/api/v1/albums/${id}/cover`, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
check((await api(admin, node('bryllup'), { photo: b1 })).status === 200 && row(node('bryllup')).cover_photo_id === b1, 'forsidebilde fra bildevisningen (API)');
check((await api(admin, node('bryllup'), { photo: j1 })).status === 400, 'API: bilde fra et annet album avvises');
check((await api(new Browser(), node('bryllup'), { photo: b2 })).status === 401 && row(node('bryllup')).cover_photo_id === b1, 'API: krever innlogging');
await api(admin, node('bryllup'), { photo: null });
const adminPage = await admin.get(`/admin/node/${node('familie')}`);
check(adminPage.text.includes('Bytt forsidebilde') && adminPage.text.includes('Valgt av deg'), 'albumsiden viser forsidebildet');

// --- Tilgang: privat, kunde, offentlig ---------------------------------------------------------
console.log('3. Tilgang');
const anon = new Browser();
r = await admin.action(A('bryllup', 'access'), { mode: 'private' });
check(r.type === 'success' && row(node('bryllup')).visibility === 'private', 'Privat: albumet blir privat');
check((await anon.get('/bryllup')).status === 303, 'besøkende ser det ikke lenger (sendes til innlogging)');

const before = mails.length;
r = await admin.action(A('bryllup', 'newClient'), { name: 'Kari Hansen', email: 'Kari@Example.com', invite: 'on' });
await wait(300);
const client = q(`SELECT * FROM groups WHERE name = 'Kari Hansen'`)[0];
const kari = q(`SELECT * FROM users WHERE email = 'kari@example.com'`)[0];
check(r.type === 'success' && client?.kind === 'client' && client.download === 'no', 'Ny kunde: kundegruppe laget (uten nedlasting)');
check(kari?.role === 'viewer' && q('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', client.id, kari.id).length === 1, 'kunden er med i gruppa');
check(q('SELECT 1 FROM node_access WHERE node_id = ? AND group_id = ?', node('bryllup'), client.id).length === 1, 'albumet er delt med kunden');
check(mails.slice(before).some((m) => m.to === 'kari@example.com'), 'invitasjonen er sendt');
const kariB = new Browser();
const link = linkFor('kari@example.com');
await kariB.post(link.replace(BASE, ''), {});
check(!!kariB.cookie, 'kunden logger inn med lenken');
const kariAlbum = await kariB.get('/bryllup');
check(kariAlbum.status === 200 && kariAlbum.text.includes('Send valget') === false && kariAlbum.text.includes('hjertet'), 'kunden ser albumet og kan velge favoritter');
let page = await admin.get(`/admin/node/${node('bryllup')}`);
const text = (html) => html.replace(/<!--[^]*?-->/g, '');
check(text(page.text).includes('Kunde: Kari Hansen'), 'albumsiden viser at albumet er levert til kunden');
const lib = await admin.get('/admin');
check(lib.text.includes('Kari Hansen') && lib.text.includes('Kunder'), 'biblioteket viser kunden og har filteret «Kunder»');

r = await admin.action(A('bryllup', 'groupDownload'), { group: client.id, on: '1' });
check(r.type === 'success' && q('SELECT download FROM groups WHERE id = ?', client.id)[0].download === 'yes', 'kunden får laste ned');
check((await kariB.get(`/download/photo/${b1}`)).status === 200, 'kunden kan laste ned originalen');
r = await admin.action(A('bryllup', 'groupDownload'), { group: client.id, on: '0' });
check(q('SELECT download FROM groups WHERE id = ?', client.id)[0].download === 'no' && (await kariB.get(`/download/photo/${b1}`)).status !== 200, 'og tilbake: kan ikke laste ned');
r = await admin.action(A('bryllup', 'groupExpiry'), { group: client.id, expires: '2030-06-30' });
check(r.type === 'success' && q('SELECT expires_at FROM groups WHERE id = ?', client.id)[0].expires_at > Date.now(), 'utløpsdato lagret');
r = await admin.action(A('bryllup', 'groupExpiry'), { group: client.id, expires: '' });
check(q('SELECT expires_at FROM groups WHERE id = ?', client.id)[0].expires_at === null, 'utløpsdato fjernet');

r = await admin.action(A('bryllup', 'addPerson'), { group: client.id, name: 'Ola', email: 'ola@example.com' });
const ola = q(`SELECT id FROM users WHERE email = 'ola@example.com'`)[0];
check(r.type === 'success' && ola && q('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', client.id, ola.id).length === 1, 'legg til person i kundegruppa');
r = await admin.action(A('bryllup', 'copyLink'), { user: ola.id });
check(r.type === 'success' && String(r.data?.link).startsWith(`${BASE}/login/lenke/`), '«Kopier lenke» gir en innloggingslenke');
const olaB = new Browser();
await olaB.post(String(r.data.link).replace(BASE, ''), {});
check((await olaB.get('/bryllup')).status === 200, 'lenken virker');
const before2 = mails.length;
r = await admin.action(A('bryllup', 'sendLink'), { user: ola.id });
await wait(300);
check(r.type === 'success' && mails.slice(before2).some((m) => m.to === 'ola@example.com'), '«Send» sender ny lenke på e-post');
r = await admin.action(A('bryllup', 'removePerson'), { group: client.id, user: ola.id });
check(q(`SELECT 1 FROM users WHERE email = 'ola@example.com'`).length === 0, 'fjern person (uten andre grupper slettes gjesten)');

r = await admin.action(A('bryllup', 'access'), { mode: 'private', removeClients: '1' });
check(r.type === 'success' && q('SELECT 1 FROM node_access WHERE node_id = ? AND group_id = ?', node('bryllup'), client.id).length === 0, 'Privat fra Kunde: kundens tilgang fjernes');
check(row(node('bryllup')).visibility === 'private' && (await kariB.get('/bryllup')).status === 404, 'albumet er fortsatt privat, kunden ser det ikke');
r = await admin.action(A('bryllup', 'toggleGroup'), { group: client.id, on: '1', makePrivate: '1' });
check(r.type === 'success' && (await kariB.get('/bryllup')).status === 200, 'lever til en kunde du har fra før');
r = await admin.action(A('bryllup', 'toggleGroup'), { group: client.id, on: '0' });
check((await kariB.get('/bryllup')).status === 404, 'fjern kunden igjen');

r = await admin.action(A('jul', 'toggleGroup'), { group: client.id, on: '1', makePrivate: '1' });
check(row(node('jul')).visibility === 'private' && (await kariB.get('/familie/jul')).status === 200, 'Kunde på et offentlig album: blir privat og delt');
r = await admin.action(A('jul', 'access'), { mode: 'public' });
check(r.type === 'success' && row(node('jul')).visibility === 'public' && (await anon.get('/familie/jul')).status === 200, 'Offentlig: alle ser albumet igjen');

r = await admin.action(A('sommer', 'newGroup'), { name: 'Familien' });
const fam = q(`SELECT * FROM groups WHERE name = 'Familien'`)[0];
check(r.type === 'success' && fam?.kind === 'family' && q('SELECT 1 FROM node_access WHERE node_id = ? AND group_id = ?', node('sommer'), fam.id).length === 1, 'Ny gruppe: laget og delt');
r = await admin.action(A('sommer', 'allowDownload'), { on: '1' });
check(r.type === 'success' && row(node('sommer')).allow_download === 1, 'nedlasting slått på for albumet');

// --- Om albumet ------------------------------------------------------------------------------
console.log('4. Om albumet');
await admin.action(A('bryllup', 'access'), { mode: 'private' });
r = await admin.action(A('bryllup', 'save'), { name: 'Bryllup Hansen', description: 'Vielse og fest', parentId: node('arkiv') });
const br = row(node('bryllup-hansen'));
check(r.type === 'success' && br?.description === 'Vielse og fest' && br.parent_id === node('arkiv'), 'navn, beskrivelse og mappe lagret');
check(br?.visibility === 'private', 'lagring av «Om albumet» endrer ikke synligheten');

// --- Biblioteket: flere på en gang -------------------------------------------------------------
console.log('5. Biblioteket');
r = await admin.action('/admin?/bulk', { op: 'private', id: [node('jul'), node('sommer')] });
check(r.type === 'success' && row(node('jul')).visibility === 'private' && row(node('sommer')).visibility === 'private', 'gjør flere private');
r = await admin.action('/admin?/bulk', { op: 'share', group: fam.id, id: [node('jul'), node('bryllup-hansen')] });
check(r.type === 'success' && q('SELECT count(*) AS n FROM node_access WHERE group_id = ?', fam.id)[0].n === 3, 'del flere med en gruppe');
r = await admin.action('/admin?/bulk', { op: 'move', target: node('arkiv'), id: [node('jul'), node('familie')] });
check(r.type === 'success' && row(node('familie')).parent_id === node('arkiv') && row(node('jul')).parent_id === node('familie'), 'flytt: mappa flyttes med innholdet');
r = await admin.action('/admin?/bulk', { op: 'move', target: node('familie'), id: [node('arkiv')] });
check(r.type === 'failure' && row(node('arkiv')).parent_id === null, 'kan ikke flytte en mappe inn i seg selv');
r = await admin.action('/admin?/bulk', { op: 'public', id: [node('jul'), node('sommer')] });
check(r.type === 'success' && row(node('jul')).visibility === 'public', 'gjør flere offentlige');
check((await new Browser().action('/admin?/bulk', { op: 'public', id: node('bryllup-hansen') })).status === 401, 'massehandlinger krever innlogging');
check(row(node('bryllup-hansen')).visibility === 'private', 'og endret ingenting');

check(!/Error|TypeError/.test(serverLog.replace(/ExperimentalWarning[^\n]*/g, '')), 'ingen feil i serverloggen');
console.log(`\nRESULTAT: ${failures} feil`);
process.exit(failures ? 1 : 0);
