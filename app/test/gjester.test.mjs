// Ende-til-ende-test av gjester (v2 familie, v3 kunder) mot en midlertidig server.
// E-post går gjennom en liten falsk SMTP-server her i testen, så lenkene fanges opp.
//
//   cd app && npm run build && node test/gjester.test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-gjester-'));
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
			payload = new URLSearchParams(form);
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

// --- Oppsett: struktur og bilder ------------------------------------------------------------
console.log('1. Oppsett');
const admin = new Browser();
const login = await admin.post('/login?/password', { email: ADMIN.email, password: ADMIN.password });
check(login.status === 303 && admin.cookie, 'admin logget inn med passord');

const node = (slug) => q('SELECT id FROM nodes WHERE slug = ?', slug)[0]?.id;
async function create(name, type, parentId = '', visibility = 'public') {
	await admin.post('/admin?/create', { name, type, parentId, visibility });
}
await create('Offentlig', 'album');
await create('Familie', 'folder', '', 'private');
await create('Jul', 'album', node('familie'));
await create('Kunde A', 'album', '', 'private');
await create('Hemmelig', 'album', '', 'private');
check(node('offentlig') && node('jul') && node('kunde-a') && node('hemmelig'), 'mapper og album laget');

const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).jpeg().toBuffer();
async function upload(albumSlug) {
	const fd = new FormData();
	fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `${albumSlug}.jpg`);
	const r = await fetch(`${BASE}/api/v1/albums/${node(albumSlug)}/photos`, { method: 'POST', body: fd, headers: { Origin: BASE, Cookie: admin.cookie } });
	return (await r.json()).id;
}
const photo = {};
for (const a of ['offentlig', 'jul', 'kunde-a', 'hemmelig']) photo[a] = await upload(a);
check(Object.values(photo).every(Boolean), 'bilder lastet opp');
const media = (slug) => {
	const p = q('SELECT id, version FROM photos WHERE id = ?', photo[slug])[0];
	return `/media/${p.id}/${p.version}/s.webp`;
};

// --- Grupper -------------------------------------------------------------------------------
console.log('2. Grupper, personer og tilgang');
const g1 = await admin.action('/admin/gjester?/createGroup', { name: 'Familien', kind: 'family' });
const familyId = g1.data?.openGroup;
check(g1.type === 'success' && familyId, 'gruppe «Familien» laget');
const g2 = await admin.action('/admin/gjester?/createGroup', { name: 'Kunde A AS', kind: 'client' });
const clientId = g2.data?.openGroup;
check(clientId, 'gruppe «Kunde A AS» (kunde) laget');

const add1 = await admin.action('/admin/gjester?/addMember', { group: familyId, name: 'Kari', email: 'Kari@Example.com', invite: 'on' });
check(add1.type === 'success' && /sendte invitasjon/.test(add1.data?.message ?? ''), 'Kari lagt til og invitert: ' + add1.data?.message);
await new Promise((r) => setTimeout(r, 200));
check(mails.some((m) => m.to === 'kari@example.com' && /delt bilder med deg/.test(m.body)), 'invitasjon kom fram på e-post (adressen med små bokstaver)');
const inviteLink = linkFor('kari@example.com');
check(inviteLink?.startsWith(`${BASE}/login/lenke/`), 'invitasjonen har innloggingslenke');

await admin.action('/admin/gjester?/grant', { group: familyId, node: node('familie') });
await admin.action('/admin/gjester?/addMember', { group: clientId, name: 'Ola', email: 'ola@example.com' });
await admin.action('/admin/gjester?/grant', { group: clientId, node: node('kunde-a') });
check(q('SELECT count(*) AS n FROM node_access')[0].n === 2, 'to tilganger lagret');
const adminAsGuest = await admin.action('/admin/gjester?/addMember', { group: clientId, email: ADMIN.email });
check(adminAsGuest.type === 'failure' && /administrator/.test(adminAsGuest.data?.error ?? ''), 'admin kan ikke legges til som gjest');

// --- Kari logger inn med invitasjonen -------------------------------------------------------
console.log('3. Kari (familie) logger inn med lenke');
const kari = new Browser();
const invitePath = new URL(inviteLink).pathname;
const confirm = await kari.get(invitePath);
check(confirm.status === 200 && confirm.text.includes('kari@example.com') && confirm.text.includes('Se bildene'), 'bekreftelsessiden viser hvem og en knapp');
check(!kari.cookie, 'å åpne lenken logger ikke inn alene (e-postprogrammer som sjekker lenker bruker den ikke opp)');
const used = await kari.post(invitePath, {});
check(used.status === 303 && used.location === '/familie' && kari.cookie, `logget inn og sendt rett til det delte (${used.location})`);
const again = await new Browser().post(invitePath, {});
check(again.status === 200 && !again.location, 'lenken kan ikke brukes to ganger');

const home = await kari.get('/');
check(home.text.includes('Delt med deg') && home.text.includes('Familie'), 'forsiden viser «Delt med deg» med Familie');
check(home.text.includes('Offentlig') && !home.text.includes('Kunde A') && !home.text.includes('Hemmelig'), 'ser offentlig, ikke andres private');
check(home.text.includes('Kari') && home.text.includes('Logg ut'), 'navnet og «Logg ut» i toppen');
check((await kari.get('/familie/jul')).status === 200, 'kan åpne album i delt mappe');
check((await kari.get(media('jul'))).status === 200, 'kan se bildefila');
check((await kari.get(`/i/${photo.jul}`)).status === 200, 'kan åpne bildesiden');
check((await kari.get('/kunde-a')).status === 404, 'Kunde A: 404');
check((await kari.get(media('kunde-a'))).status === 404, 'Kunde A sin bildefil: 404');
check((await kari.get(media('hemmelig'))).status === 404, 'privat, ikke delt: 404');
check((await kari.get(`/download/photo/${photo.jul}`)).status === 403, 'nedlasting av originaler av når albumet ikke tillater det');
check((await kari.get('/admin')).status === 403, 'kommer ikke inn i admin');
check((await kari.get(`/api/v1/me`)).status === 403, 'API-et er stengt for gjester');

// --- Innlogging med lenke fra innloggingssiden ---------------------------------------------
console.log('4. «Send meg en lenke»');
const before = mails.length;
const anon = new Browser();
const sentOla = await anon.action('/login?/link', { email: 'ola@example.com' });
const sentNobody = await anon.action('/login?/link', { email: 'ingen@example.com' });
const sentAdmin = await anon.action('/login?/link', { email: ADMIN.email });
await new Promise((r) => setTimeout(r, 200));
check(sentOla.data?.sent === 'ola@example.com' && sentNobody.data?.sent === 'ingen@example.com', 'samme svar for kjente og ukjente adresser');
check(mails.length === before + 1 && mails[mails.length - 1].to === 'ola@example.com', 'bare Ola fikk e-post (ikke ukjent adresse eller admin)');
const olaLink = new URL(linkFor('ola@example.com'));
check(/Her er lenken for =C3=A5 logge inn|Her er lenken for å logge inn/.test(mails[mails.length - 1].body), 'e-post med innloggingstekst');
const ola = new Browser();
const olaIn = await ola.post(olaLink.pathname + olaLink.search, {});
check(olaIn.status === 303 && olaIn.location === '/kunde-a', `Ola sendt rett til Kunde A (${olaIn.location})`);
check((await ola.get('/kunde-a')).status === 200, 'Ola ser Kunde A');
check((await ola.get('/familie/jul')).status === 404, 'Ola ser ikke familiens album');

// next= følger med lenken
const withNext = await anon.action('/login?next=%2Fkunde-a&/link', { email: 'ola@example.com' });
check(withNext.type === 'success', 'lenke med next');
await new Promise((r) => setTimeout(r, 200));
check(linkFor('ola@example.com')?.includes('next=%2Fkunde-a'), 'lenken tar deg tilbake dit du var');

// bremse: maks 3 per adresse per kvarter
await anon.action('/login?/link', { email: 'ola@example.com' });
const n = mails.length;
await anon.action('/login?/link', { email: 'ola@example.com' });
await new Promise((r) => setTimeout(r, 200));
check(mails.length === n, 'bremse: 4. lenke til samme adresse sendes ikke');

// --- Brødsmuler: privat mappe over et delt album vises ikke ---------------------------------
console.log('5. Brødsmuler');
await admin.action('/admin/gjester?/grant', { group: clientId, node: node('jul') });
const olaJul = await ola.get('/familie/jul');
check(olaJul.status === 200 && !olaJul.text.includes('href="/familie"'), 'Ola ser Jul, men ikke lenke til den private mappa Familie');
const olaHome = await ola.get('/');
check(olaHome.text.includes('Jul') && olaHome.text.includes('Kunde A'), 'begge delte album under «Delt med deg»');

// --- Deling fra albumsiden ------------------------------------------------------------------
console.log('6. Deling fra albumsiden');
await admin.action(`/admin/node/${node('hemmelig')}?/share`, { group: familyId });
check((await kari.get('/hemmelig')).status === 200, 'delt fra albumsiden: Kari ser Hemmelig');
const page = await admin.get(`/admin/node/${node('jul')}`);
check(page.text.includes('via «Familie»'), 'albumsiden viser arvet tilgang');
await admin.action(`/admin/node/${node('hemmelig')}?/share`, {});
check((await kari.get('/hemmelig')).status === 404, 'deling fjernet: 404 igjen');

// --- Fjerne tilgang -------------------------------------------------------------------------
console.log('7. Fjerne tilgang');
await admin.action('/admin/gjester?/revoke', { group: clientId, node: node('kunde-a') });
check((await ola.get('/kunde-a')).status === 404, 'Ola mister Kunde A med en gang');
const kariId = q(`SELECT id FROM users WHERE email = 'kari@example.com'`)[0].id;
await admin.action('/admin/gjester?/removeMember', { group: familyId, user: kariId });
check(q(`SELECT count(*) AS n FROM users WHERE email = 'kari@example.com'`)[0].n === 0, 'Kari er slettet når hun ikke er med i noen gruppe');
const kariAfter = await kari.get('/familie/jul');
check(kariAfter.status === 303 && kariAfter.location?.startsWith('/login'), 'Kari er logget ut (sendt til innlogging)');

const copy = await admin.action('/admin/gjester?/copyLink', { user: q(`SELECT id FROM users WHERE email = 'ola@example.com'`)[0].id });
check(copy.data?.link?.url?.startsWith(`${BASE}/login/lenke/`), '«Kopier lenke» gir en lenke');
await admin.action('/admin/gjester?/deleteGroup', { group: clientId });
check(q(`SELECT count(*) AS n FROM users WHERE role = 'viewer'`)[0].n === 0, 'sletter gruppa: gjester uten grupper forsvinner');
check((await ola.get('/')).text.includes('Logg inn'), 'Ola er logget ut');
check(!/E-post \(ikke sendt/.test(serverLog), 'all e-post gikk via SMTP');

console.log(`\nRESULTAT: ${failures} feil`);
process.exit(failures ? 1 : 0);
