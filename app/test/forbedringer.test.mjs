// Ende-til-ende-test av favoritter, utløpsdato, nedlasting per gruppe, varsler, søk,
// lysbildefremvisning og vannmerke – mot en midlertidig server med falsk SMTP.
//
//   cd app && npm run build && node test/forbedringer.test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-forbedringer-'));
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


const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const mailsTo = (to) => mails.filter((m) => m.to === to);
const decoded = (m) => m.body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const osloDate = (offsetDays) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(Date.now() + offsetDays * 86400_000);

// --- Oppsett ---------------------------------------------------------------------------------
console.log('1. Oppsett');
const admin = new Browser();
const login = await admin.post('/login?/password', { email: ADMIN.email, password: ADMIN.password });
check(login.status === 303 && admin.cookie, 'admin logget inn');

const node = (slug) => q('SELECT id FROM nodes WHERE slug = ?', slug)[0]?.id;
await admin.post('/admin?/create', { name: 'Fjordtur', type: 'album', visibility: 'public', allowDownload: 'on' });
await admin.post('/admin?/create', { name: 'Kunde', type: 'album', visibility: 'private', allowDownload: 'on' });
await admin.post('/admin?/create', { name: 'Familie', type: 'album', visibility: 'private', allowDownload: 'on' });
check(node('fjordtur') && node('kunde') && node('familie'), 'album laget');

const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#4a6a8a' } }).jpeg().toBuffer();
async function upload(albumSlug, filename, title = '', keywords = []) {
	const fd = new FormData();
	fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), filename);
	fd.append('title', title);
	fd.append('keywords', JSON.stringify(keywords));
	const r = await fetch(`${BASE}/api/v1/albums/${node(albumSlug)}/photos`, { method: 'POST', body: fd, headers: { Origin: BASE, Cookie: admin.cookie } });
	return (await r.json()).id;
}
const pub = await upload('fjordtur', 'DSC_0001.jpg', 'Kåre på fjorden', ['Hardanger']);
const k1 = await upload('kunde', 'IMG_1001.jpg', 'Bryllup', ['brud']);
const k2 = await upload('kunde', 'IMG_1002.jpg', 'Bryllup kake');
const k3 = await upload('kunde', 'IMG_1003.jpg', 'Bryllup dans');
const fam = await upload('familie', 'jul.jpg', 'Julaften');
check([pub, k1, k2, k3, fam].every(Boolean), 'bilder lastet opp');
const ver = (id) => q('SELECT version FROM photos WHERE id = ?', id)[0].version;

// Grupper: kunde (nedlasting av som standard) og familie (følger albumet)
const gc = await admin.action('/admin/gjester?/createGroup', { name: 'Brudeparet', kind: 'client' });
const clientId = gc.data?.openGroup;
const gf = await admin.action('/admin/gjester?/createGroup', { name: 'Familien', kind: 'family' });
const familyId = gf.data?.openGroup;
check(q('SELECT download FROM groups WHERE id = ?', clientId)[0]?.download === 'no', 'ny kundegruppe: nedlasting av som standard');
check(q('SELECT download FROM groups WHERE id = ?', familyId)[0]?.download === 'album', 'ny familiegruppe: følger albumet');
await admin.action('/admin/gjester?/addMember', { group: clientId, name: 'Ola', email: 'ola@example.com' });
await admin.action('/admin/gjester?/grant', { group: clientId, node: node('kunde') });
await admin.action('/admin/gjester?/addMember', { group: familyId, name: 'Kari', email: 'kari@example.com' });
await admin.action('/admin/gjester?/grant', { group: familyId, node: node('familie') });

async function loginAs(email) {
	const userId = q('SELECT id FROM users WHERE email = ?', email)[0].id;
	const link = await admin.action('/admin/gjester?/copyLink', { user: userId });
	const b = new Browser();
	await b.post(new URL(link.data.link.url).pathname, {});
	return b;
}

// --- Varsel ved første innlogging -------------------------------------------------------------
console.log('2. Varsel når gjesten åpner invitasjonen');
const ola = await loginAs('ola@example.com');
await wait();
const first = mailsTo(ADMIN.email);
check(ola.cookie && first.length === 1 && /Ola har logget inn for f/.test(decoded(first[0])), 'du får e-post første gang Ola logger inn');
check(/Kunde/.test(decoded(first[0])), 'e-posten sier hva Ola har tilgang til');
await loginAs('ola@example.com');
await wait();
check(mailsTo(ADMIN.email).length === 1, 'ingen ny e-post neste gang');
const kari = await loginAs('kari@example.com');
await wait();

// --- Nedlasting per gruppe ---------------------------------------------------------------------
console.log('3. Nedlasting per gruppe');
check((await ola.get(`/download/photo/${k1}`)).status === 403, 'kunde: kan ikke laste ned selv om albumet tillater det');
check((await ola.get(`/download/album/${node('kunde')}`)).status === 403, 'kunde: zip stengt');
check(!(await ola.get('/kunde')).text.includes('Last ned alle'), 'kunde: ingen «Last ned alle»-knapp');
check((await kari.get(`/download/photo/${fam}`)).status === 200, 'familie: følger albumet (tillatt)');
await admin.action('/admin/gjester?/updateGroup', { group: clientId, name: 'Brudeparet', kind: 'client', download: 'yes', expires: '' });
check((await ola.get(`/download/photo/${k1}`)).status === 200, 'kunde etter «Ja, alltid»: kan laste ned');
check((await ola.get('/kunde')).text.includes('Last ned alle'), 'kunde: «Last ned alle» vises');
await admin.action('/admin/gjester?/updateGroup', { group: familyId, name: 'Familien', kind: 'family', download: 'no', expires: '' });
check((await kari.get(`/download/photo/${fam}`)).status === 403, 'familie etter «Nei»: stengt');
check((await new Browser().get(`/download/photo/${pub}`)).status === 200, 'offentlig album med nedlasting: alle kan laste ned');

// --- Favoritter --------------------------------------------------------------------------------
console.log('4. Favoritter');
const fav = (b, photo, on = true) =>
	b.req('POST', '/api/v1/favorites', { body: JSON.stringify({ photo, on }), headers: { 'content-type': 'application/json' } });
check((await fav(ola, k1)).status === 200 && (await fav(ola, k3)).status === 200, 'Ola hjerter to bilder');
check((await fav(ola, k2)).status === 200 && (await fav(ola, k2, false)).status === 200, 'og kan ta hjertet av igjen');
check(q('SELECT count(*) AS n FROM favorites')[0].n === 2, 'to favoritter lagret');
check((await fav(kari, k1)).status === 404, 'Kari kan ikke hjerte bilder hun ikke ser');
check((await fav(ola, pub)).status === 404, 'ikke i offentlige album (bare i det som er delt)');
check((await fav(new Browser(), k1)).status === 401, 'ikke uten innlogging');
check((await fav(admin, k1)).status === 404, 'ikke for admin');
const evil = await ola.req('POST', '/api/v1/favorites', { body: JSON.stringify({ photo: k2, on: true }), headers: { 'content-type': 'application/json', Origin: 'https://evil.example' } });
check(evil.status === 403, 'CSRF: fremmed side kan ikke sette favoritter');
const albumPage = await ola.get('/kunde');
check(albumPage.text.includes('2 favoritter') && albumPage.text.includes('Send valget'), 'albumsiden viser «2 favoritter» og «Send valget»');
const before = mailsTo(ADMIN.email).length;
const sent = await ola.action('/kunde?/sendFavorites', {});
await wait();
check(sent.type === 'success' && sent.data?.sent === 2, 'valget sendt');
const favMail = mailsTo(ADMIN.email).slice(before)[0];
check(favMail && /IMG_1001 IMG_1003/.test(decoded(favMail)), 'du får e-post med filnavnene (klare for Lightroom)');
check(q('SELECT count FROM favorite_submissions')[0]?.count === 2, 'innsendingen er lagret');
check((await ola.get('/kunde')).text.includes('Send valget på nytt'), 'knappen blir «Send valget på nytt»');
const adminNode = await admin.get(`/admin/node/${node('kunde')}`);
check(adminNode.text.includes('id="favoritter"') && adminNode.text.includes('Ola') && adminNode.text.includes('sendt'), 'albumsiden i admin viser Olas valg');
const pubFav = await kari.action('/fjordtur?/sendFavorites', {});
check(pubFav.type === 'failure', 'kan ikke sende valg fra et offentlig album');

// --- Utløpsdato --------------------------------------------------------------------------------
console.log('5. Utløpsdato');
await admin.action('/admin/gjester?/updateGroup', { group: clientId, name: 'Brudeparet', kind: 'client', download: 'yes', expires: osloDate(-1) });
check((await ola.get('/kunde')).status === 404, 'utløpt i går: Ola ser ikke albumet');
check((await ola.get(`/media/${k1}/${ver(k1)}/s.webp`)).status === 404, 'utløpt: bildefilene er stengt');
check((await ola.get('/')).text.includes('har utløpt'), 'forsiden forklarer at tilgangen har utløpt');
check((await admin.get('/admin/gjester')).text.includes('Utløpt'), 'admin viser «Utløpt»');
await admin.action('/admin/gjester?/updateGroup', { group: clientId, name: 'Brudeparet', kind: 'client', download: 'yes', expires: osloDate(0) });
check((await ola.get('/kunde')).status === 200, 'til og med i dag: Ola ser albumet igjen');
const gpage = await admin.get('/admin/gjester');
check(gpage.text.includes('Til og med'), 'admin viser «Til og med …»');
const exp = q('SELECT expires_at FROM groups WHERE id = ?', clientId)[0].expires_at;
const endOslo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'short' }).format(exp);
check(endOslo === `${osloDate(1)} 00:00`, `slutter ved midnatt norsk tid (${endOslo})`);
await admin.action('/admin/gjester?/updateGroup', { group: clientId, name: 'Brudeparet', kind: 'client', download: 'yes', expires: '' });
check(q('SELECT expires_at FROM groups WHERE id = ?', clientId)[0].expires_at === null, 'tomt felt: ingen utløpsdato');
const bad = await admin.action('/admin/gjester?/updateGroup', { group: clientId, name: 'Brudeparet', kind: 'client', expires: 'snart' });
check(bad.type === 'failure', 'ugyldig dato avvises');

// --- Søk ---------------------------------------------------------------------------------------
console.log('6. Søk');
const anon = new Browser();
const s1 = await anon.get('/sok?q=kare+fjorden');
check(s1.status === 200 && s1.text.includes(`/i/${pub}`), 'finner «Kåre på fjorden» med «kare fjorden» (uten å)');
check((await anon.get('/sok?q=hardanger')).text.includes(`/i/${pub}`), 'søker i stikkord');
check((await anon.get('/sok?q=dsc_0001')).text.includes(`/i/${pub}`), 'søker i filnavn');
const s2 = await anon.get('/sok?q=bryllup');
check(!s2.text.includes(`/i/${k1}`) && s2.text.includes('Fant ingenting'), 'besøkende finner ikke private bilder');
const s3 = await ola.get('/sok?q=bryllup');
check(s3.text.includes(`/i/${k1}`) && s3.text.includes(`/i/${k2}`) && !s3.text.includes(`/i/${fam}`), 'Ola finner bildene som er delt med ham, ikke andres');
check((await ola.get('/sok?q=bryllup+kake')).text.includes(`/i/${k2}`) && !(await ola.get('/sok?q=bryllup+kake')).text.includes(`/i/${k1}`), 'alle ordene må finnes');
check((await anon.get('/sok?q=fjordtur')).text.includes('href="/fjordtur"'), 'finner album på navn');
check((await anon.get('/')).text.includes('href="/sok"'), 'søkelenke i toppen');

// Søkeboksen (⌘K) henter fra /api/v1/search.
const sj = async (b, qs) => JSON.parse((await b.get(`/api/v1/search?q=${encodeURIComponent(qs)}`)).text);
const names = (r) => r.nodes.map((n) => n.name);
const ids = (r) => r.photos.map((p) => p.id);
const p0 = await sj(anon, '');
check(names(p0).includes('Fjordtur') && !names(p0).includes('Kunde') && !names(p0).includes('Familie'), 'søkeboks: forslag uten søkeord viser bare offentlige album for besøkende');
const pOla = await sj(ola, '');
check(names(pOla).includes('Kunde') && !names(pOla).includes('Familie'), 'søkeboks: Ola får forslag med albumet som er delt med ham');
check(names(await sj(admin, '')).includes('Familie'), 'søkeboks: admin ser alt');
check(!ids(await sj(anon, 'bryllup')).length && !names(await sj(anon, 'kunde')).length, 'søkeboks: besøkende finner ikke private bilder eller album');
check(ids(await sj(ola, 'bryllup')).includes(k1) && !ids(await sj(ola, 'bryllup')).includes(fam), 'søkeboks: Ola finner sine bilder, ikke andres');
const pf = await sj(anon, 'kare fjorden');
check(pf.photos[0]?.id === pub && pf.photos[0].href === `/i/${pub}` && pf.photos[0].thumb?.src, 'søkeboks: bildetreff med lenke og miniatyr');
const pa = (await sj(anon, 'fjordtur')).nodes[0];
check(pa?.href === '/fjordtur' && /bilde/.test(pa.meta), 'søkeboks: albumtreff med lenke og antall bilder');

// --- Lysbildefremvisning -----------------------------------------------------------------------
console.log('7. Lysbildefremvisning');
const photoPage = await anon.get(`/i/${pub}`);
check(!photoPage.text.includes('Start lysbildefremvisning'), 'ikke vist for album med ett bilde');
const multi = await ola.get(`/i/${k1}`);
check(multi.text.includes('Start lysbildefremvisning'), 'knapp for lysbildefremvisning i bildevisningen');

// --- Vannmerke ---------------------------------------------------------------------------------
console.log('8. Vannmerke');
const plainUrl = `/media/${pub}/${ver(pub)}/m.webp`;
const plain = await fetch(BASE + plainUrl).then((r) => r.arrayBuffer());
const noText = await admin.action('/admin/innstillinger?/watermark', { enabled: 'on', text: '', position: 'corner' });
check(noText.type === 'failure', 'kan ikke slå på uten tekst');
const saved = await admin.action('/admin/innstillinger?/watermark', { enabled: 'on', text: '© Test Testesen', position: 'corner' });
check(saved.type === 'success', 'vannmerke slått på');
const rev = JSON.parse(q(`SELECT value FROM settings WHERE key = 'watermark'`)[0].value).rev;
const fj = await anon.get('/fjordtur');
check(fj.text.includes(`wm${rev}-m.webp`) && fj.text.includes(`wm${rev}-og.jpg`), 'besøkende får vannmerkede URL-er (også delingsbildet)');
check(fj.text.includes('/s.webp'), 'små miniatyrer uten vannmerke');
const redir = await fetch(BASE + plainUrl, { redirect: 'manual' });
check(redir.status === 302 && redir.headers.get('location').endsWith(`wm${rev}-m.webp`), 'den vanlige URL-en sender besøkende til vannmerket versjon');
const marked = await fetch(`${BASE}/media/${pub}/${ver(pub)}/wm${rev}-m.webp`);
const markedBuf = await marked.arrayBuffer();
check(marked.status === 200 && marked.headers.get('content-type') === 'image/webp', 'vannmerket bilde lages og leveres');
check(Buffer.compare(Buffer.from(plain), Buffer.from(markedBuf)) !== 0, 'og det er et annet bilde enn originalen');
const meta = await sharp(Buffer.from(markedBuf)).metadata();
check(meta.width === 1024, 'samme størrelse som før');
check(fs.readdirSync(path.join(WORK, `data/derived/${pub}/v${ver(pub)}`)).includes(`wm${rev}-m.webp`), 'lagret ved siden av de vanlige');
const adminPlain = await fetch(BASE + plainUrl, { headers: { Cookie: admin.cookie }, redirect: 'manual' });
check(adminPlain.status === 200, 'du ser bildene uten vannmerke');
check(!/wm\d+-/.test((await ola.get('/kunde')).text), 'private album delt med gjester: uten vannmerke');
check((await fetch(`${BASE}/media/${pub}/${ver(pub)}/s.webp`, { redirect: 'manual' })).status === 200, 'miniatyren leveres direkte');
const settingsPage = await admin.get('/admin/innstillinger');
check(settingsPage.text.includes(`wm${rev}-l.webp`), 'innstillingssiden viser forhåndsvisning');
await admin.action('/admin/innstillinger?/watermark', { enabled: 'on', text: '© Ny tekst', position: 'center' });
await wait(300);
check(!fs.readdirSync(path.join(WORK, `data/derived/${pub}/v${ver(pub)}`)).includes(`wm${rev}-m.webp`), 'gamle vannmerkede filer ryddes bort ved endring');
const old = await fetch(`${BASE}/media/${pub}/${ver(pub)}/wm${rev}-m.webp`, { redirect: 'manual' });
check(old.status === 302 && old.headers.get('location').endsWith(`wm${rev + 1}-m.webp`), 'gammel vannmerke-URL sendes til ny versjon');
await admin.action('/admin/innstillinger?/watermark', { position: 'corner', text: '© Ny tekst' });
check((await fetch(BASE + plainUrl, { redirect: 'manual' })).status === 200, 'slått av: vanlige bilder igjen');
check(!/wm\d+-/.test((await anon.get('/fjordtur')).text), 'slått av: ingen vannmerke-URL-er');
check(!/Vannmerke feilet|Kunne ikke sende/.test(serverLog), 'ingen feil i serverloggen');

console.log(`\nRESULTAT: ${failures} feil`);
if (failures) console.log(serverLog.slice(-3000));
process.exit(failures ? 1 : 0);
