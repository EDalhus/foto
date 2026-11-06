// Ende-til-ende-test av kategorier: dele innholdet i en mappe inn i grupper (f.eks. båter etter rederi),
// og de forskjellige visningene kundene kan få.
//
//   cd app && npm run build && node test/kategorier.test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-kategorier-'));
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
		NODE_NO_WARNINGS: '1'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
process.on('exit', () => {
	server.kill();
	fs.rmSync(WORK, { recursive: true, force: true });
});
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`${BASE}/health`)).ok) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 100));
}
const q = (sql, ...p) => {
	const d = new DatabaseSync(path.join(WORK, 'data/foto.db'), { readOnly: true });
	try {
		return d.prepare(sql).all(...p);
	} finally {
		d.close();
	}
};

// --- «Nettleser» med egen cookie ----------------------------------------------------------------
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
		for (const c of res.headers.getSetCookie?.() ?? []) {
			const [pair] = c.split(';');
			if (pair.startsWith('foto_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
		}
		return { status: res.status, location: res.headers.get('location'), text: await res.text() };
	}
	get(url) {
		return this.req('GET', url);
	}
	post(url, form) {
		return this.req('POST', url, { form, headers: { accept: 'text/html' } });
	}
	async action(url, form) {
		const r = await this.req('POST', url, { form, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
		try {
			const j = JSON.parse(r.text);
			return { ...r, type: j.type, data: j.data ? devalue(j.data) : null };
		} catch {
			return { ...r, type: 'html', data: null };
		}
	}
}
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
// Det som faktisk vises: uten SvelteKit sine kommentarmarkører og uten dataene til hydrering (<script>).
const text = (html) => html.replace(/<script[^]*?<\/script>/g, '').replace(/<!--[^]*?-->/g, '');
// Har et element alle disse klassene? (Svelte legger inn sin egen klasse mellom dem.)
const hasClass = (html, ...names) =>
	[...text(html).matchAll(/class="([^"]*)"/g)].some((m) => names.every((n) => m[1].split(/\s+/).includes(n)));
// Rekkefølgen tekstbitene står i på siden (-1 = mangler).
const order = (html, ...parts) => parts.map((p) => text(html).indexOf(p));
const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

// --- Oppsett ----------------------------------------------------------------------------------------
console.log('1. Oppsett');
const admin = new Browser();
await admin.post('/login?/password', { email: ADMIN.email, password: ADMIN.password });
const id = (name) => q('SELECT id FROM nodes WHERE name = ?', name)[0]?.id;
await admin.post('/admin?/create', { name: 'Kaikanten Terminal', type: 'folder', visibility: 'public' });
await admin.post('/admin?/create', { name: 'Annet', type: 'folder', visibility: 'public' });
const F = id('Kaikanten Terminal');
const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#557788' } }).jpeg().toBuffer();
async function album(name, parent, photos = 1) {
	await admin.post(`/admin/node/${parent}?/create`, { name, type: 'album', visibility: 'public' });
	for (let i = 0; i < photos; i++) {
		const fd = new FormData();
		fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `${name}-${i}.jpg`);
		await fetch(`${BASE}/api/v1/albums/${id(name)}/photos`, { method: 'POST', body: fd, headers: { Origin: BASE, Cookie: admin.cookie } });
	}
	return id(name);
}
for (const b of ['Nordlys', 'Havørn', 'Polarstjerne', 'Sjøsprøyt', 'Lagerhallen']) await album(b, F);
await album('Tomt album', F, 0);
await album('Utenfor', id('Annet'));
check(q('SELECT count(*) AS n FROM nodes WHERE parent_id = ?', F)[0].n === 6, 'mappe med seks album');
const A = (action) => `/admin/node/${F}?/${action}`;

// --- Lage kategorier -------------------------------------------------------------------------------------
console.log('2. Lage kategorier');
let r = await admin.action(A('categoryCreate'), { name: 'Rederi Nord', color: 'blue' });
const k1 = r.data?.categoryId;
check(r.type === 'success' && !!k1 && /er laget/.test(r.data.message), 'kategori laget');
r = await admin.action(A('categoryCreate'), { name: '  Kystfrakt  ', color: '' });
const k2 = r.data?.categoryId;
check(r.type === 'success' && q('SELECT name, color FROM categories WHERE id = ?', k2)[0].name === 'Kystfrakt', 'navnet ryddes (mellomrom), farge er valgfri');
check((await admin.action(A('categoryCreate'), { name: 'rederi nord' })).type === 'failure', 'samme navn to ganger (store/små bokstaver) avvises');
check((await admin.action(A('categoryCreate'), { name: '   ' })).type === 'failure', 'tomt navn avvises');
check((await admin.action(A('categoryCreate'), { name: 'X', color: 'gull' })).type === 'failure', 'ukjent farge avvises');
check((await admin.action(`/admin/node/${id('Nordlys')}?/categoryCreate`, { name: 'I et album' })).type === 'failure', 'kategorier bare i mapper, ikke i album');
r = await admin.action(`/admin/node/${id('Annet')}?/categoryCreate`, { name: 'Annen mappe sin' });
const kOther = r.data?.categoryId;
check(r.type === 'success' && q('SELECT count(*) AS n FROM categories WHERE parent_id = ?', F)[0].n === 2, 'hver mappe har sine egne kategorier');

// --- Legge album i kategorier ------------------------------------------------------------------------------
console.log('3. Legge album i kategorier');
r = await admin.action(A('setCategory'), { category: k1, node: [id('Nordlys'), id('Havørn'), id('Tomt album')] });
check(r.type === 'success' && /3 album ligger nå i «Rederi Nord»/.test(r.data.message), 'tre album i «Rederi Nord» på en gang');
r = await admin.action(A('setCategory'), { category: k2, node: [id('Polarstjerne'), id('Sjøsprøyt')] });
check(r.type === 'success' && q('SELECT count(*) AS n FROM nodes WHERE category_id = ?', k2)[0].n === 2, 'to i «Kystfrakt»');
check((await admin.action(A('setCategory'), { category: k1, node: id('Utenfor') })).type === 'failure', 'album i en annen mappe kan ikke legges her');
check((await admin.action(A('setCategory'), { category: kOther, node: id('Nordlys') })).type === 'failure', 'kategorien til en annen mappe kan ikke brukes');
check((await admin.action(A('categoryUpdate'), { id: kOther, name: 'Kapret' })).type === 'failure', 'kan ikke endre kategorien til en annen mappe herfra');
let page = (await admin.get(`/admin/node/${F}`)).text;
check(text(page).includes('Kategorier') && page.includes('?/setCategory') && text(page).includes('Uten kategori'), 'admin: innholdet gruppert, med velger per album');

// --- Visningene ---------------------------------------------------------------------------------------------
console.log('4. Visningene for kundene');
const visitor = new Browser();
page = (await visitor.get('/kaikanten-terminal')).text;
const sectionsOnly = (html) => text(html).slice(text(html).indexOf('class="sections'));
// Innenfor en kategori står albumene i mappas vanlige rekkefølge (nyeste først).
const [nn, ar, gu, sj, ma, an, bu] = order(sectionsOnly(page), 'Rederi Nord', 'Nordlys', 'Havørn', 'Kystfrakt', 'Polarstjerne', 'Andre', 'Lagerhallen');
check(nn >= 0 && nn < Math.min(ar, gu) && Math.max(ar, gu) < sj && sj < ma && ma < an && an < bu, 'standard «Overskrifter»: kategoriene i rekkefølge, albumene under sin, «Andre» sist');
check(hasClass(page, 'jump') && ascending(order(page, 'Rederi Nord', 'Kystfrakt', 'Andre')), '«Hopp til» når det er tre eller flere kategorier');
check(hasClass(page, 'sec-head') && !text(page).includes('Tomt album'), 'tomme album vises ikke for besøkende');
check((await admin.action(A('categoryMove'), { id: k2, dir: 'up' })).type === 'success', 'flytt «Kystfrakt» opp');
page = (await visitor.get('/kaikanten-terminal')).text;
check(ascending(order(sectionsOnly(page), 'Kystfrakt', 'Rederi Nord', 'Andre')), 'ny rekkefølge på siden');
await admin.action(A('categoryMove'), { id: k2, dir: 'down' });

const style = async (s) => {
	const res = await admin.action(A('categoryStyle'), { style: s });
	return { res, html: (await visitor.get('/kaikanten-terminal')).text };
};
let out = await style('tags');
check(out.res.type === 'success' && /Merkelapp/.test(out.res.data.message) && hasClass(out.html, 'ctag'), '«Merkelapp»: kategorien står på kortene');
check(!hasClass(out.html, 'sec-head'), '… og ingen overskrifter');
out = await style('filter');
check(hasClass(out.html, 'chips') && text(out.html).includes('Alle'), '«Filterknapper»: knapper øverst');
const filtered = text((await visitor.get('/kaikanten-terminal?kategori=kystfrakt')).text);
check(filtered.includes('Polarstjerne') && filtered.includes('Sjøsprøyt') && !filtered.includes('Nordlys') && !filtered.includes('Lagerhallen'), '?kategori=kystfrakt viser bare Kystfrakt (lenken kan deles)');
const unknown = text((await visitor.get('/kaikanten-terminal?kategori=finnes-ikke')).text);
check(unknown.includes('Nordlys') && unknown.includes('Lagerhallen'), 'ukjent kategori i adressen: alt vises');
out = await style('boxes');
check(hasClass(out.html, 'sections', 'boxes'), '«Bokser»');
out = await style('rows');
check(hasClass(out.html, 'grid', 'row') && hasClass(out.html, 'rowsec'), '«Rader»: én rad per kategori');
out = await style('stacks');
check(hasClass(out.html, 'stack') && text(out.html).includes('Lagerhallen'), '«Bunker»: kategoriene som bunker, albumene uten kategori som vanlige kort');
check(!text(out.html).includes('Havørn'), '… albumene i bunkene vises først når bunken åpnes');
const opened = text((await visitor.get('/kaikanten-terminal?kategori=rederi-nord')).text);
check(opened.includes('Alle kategorier') && opened.includes('Havørn') && !opened.includes('Polarstjerne'), 'åpnet bunke: albumene i kategorien og «Alle kategorier»');
out = await style('none');
check(!hasClass(out.html, 'sec-head') && !hasClass(out.html, 'chips') && text(out.html).includes('Nordlys'), '«Av»: vanlig rutenett');
check((await admin.action(A('categoryStyle'), { style: 'regnbue' })).type === 'failure', 'ukjent visning avvises');
await style('sections');

// --- Om albumet, flytting og sletting -----------------------------------------------------------------------
console.log('5. Om albumet, flytting og sletting');
const B = id('Lagerhallen');
r = await admin.action(`/admin/node/${B}?/save`, { name: 'Lagerhallen', description: '', parentId: F, categoryId: k2 });
check(r.type === 'success' && q('SELECT category_id FROM nodes WHERE id = ?', B)[0].category_id === k2, '«Om albumet»: kategori valgt på albumet');
check((await admin.action(`/admin/node/${B}?/save`, { name: 'Lagerhallen', parentId: F, categoryId: kOther })).type === 'failure', 'kategori fra en annen mappe avvises');
const albumPage = text((await admin.get(`/admin/node/${B}`)).text);
check(albumPage.includes('Kategori i mappa') && albumPage.includes('Kystfrakt'), 'albumsiden viser kategoriene i mappa');
r = await admin.action(`/admin/node/${B}?/save`, { name: 'Lagerhallen', parentId: id('Annet'), categoryId: k2 });
check(r.type === 'success' && q('SELECT category_id, parent_id FROM nodes WHERE id = ?', B)[0].category_id === null, 'flyttet til en annen mappe: mister kategorien');
await admin.action(`/admin/node/${B}?/save`, { name: 'Lagerhallen', parentId: F });
r = await admin.action(A('categoryUpdate'), { id: k1, name: 'Nord', color: 'violet', description: 'Levert i september.' });
page = text((await visitor.get('/kaikanten-terminal')).text);
check(r.type === 'success' && page.includes('Nord') && page.includes('Levert i september.') && !page.includes('Rederi Nord'), 'nytt navn og tekst vises for kundene');
check((await admin.action(A('categoryUpdate'), { id: k1, name: 'Kystfrakt' })).type === 'failure', 'kan ikke gi samme navn som en annen kategori');
r = await admin.action(A('categoryDelete'), { id: k2 });
check(r.type === 'success' && q('SELECT count(*) AS n FROM nodes WHERE category_id = ?', k2)[0].n === 0, 'slettet kategori: albumene er uten kategori');
check(q('SELECT count(*) AS n FROM nodes WHERE parent_id = ?', F)[0].n === 6, '… og ligger fortsatt i mappa');
await admin.action(A('categoryDelete'), { id: k1 });
page = (await visitor.get('/kaikanten-terminal')).text;
check(!hasClass(page, 'sec-head') && text(page).includes('Polarstjerne'), 'ingen kategorier igjen: vanlig rutenett');

// --- Forsiden -------------------------------------------------------------------------------------------------
console.log('6. Kategorier på forsiden');
r = await admin.action('/admin?/categoryCreate', { name: 'Kunder', color: 'aqua' });
const home = r.data?.categoryId;
check(r.type === 'success' && q('SELECT parent_id FROM categories WHERE id = ?', home)[0].parent_id === null, 'kategori på forsiden');
r = await admin.action(`/admin/node/${F}?/save`, { name: 'Kaikanten Terminal', parentId: '', categoryId: home });
check(r.type === 'success' && q('SELECT category_id FROM nodes WHERE id = ?', F)[0].category_id === home, 'mappa på toppnivå lagt i «Kunder»');
await admin.action('/admin?/categoryStyle', { style: 'tags' });
page = (await visitor.get('/')).text;
check(hasClass(page, 'ctag') && ascending(order(page, 'Kunder', 'Kaikanten Terminal')) && text(page).includes('Annet'), 'forsiden viser kategorien (Merkelapp)');
const lib = text((await admin.get('/admin')).text);
check(lib.includes('Kategorier på forsiden') && lib.includes('Kunder'), 'Bibliotek: kategoriene på forsiden og merkelapp i lista');

// --- Tilgang og trygghet ----------------------------------------------------------------------------------------
console.log('7. Tilgang og trygghet');
const anon = new Browser();
r = await anon.req('POST', A('categoryCreate'), { form: { name: 'Hack' }, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
check(r.status === 401 && q(`SELECT count(*) AS n FROM categories WHERE name = 'Hack'`)[0].n === 0, 'uten innlogging: avvist');
r = await anon.req('POST', '/admin?/categoryStyle', { form: { style: 'none' }, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
check(r.status === 401, 'forsiden kan heller ikke endres uten innlogging');
r = await admin.action(A('categoryCreate'), { name: '<img src=x onerror=alert(1)>' });
await admin.action(A('setCategory'), { category: r.data?.categoryId, node: id('Nordlys') });
page = (await visitor.get('/kaikanten-terminal')).text;
check(!page.includes('<img src=x') && page.includes('&lt;img src=x'), 'kategorinavn vises som tekst (ingen HTML)');
const folderCats = q('SELECT count(*) AS n FROM categories WHERE parent_id = ?', F)[0].n;
await admin.action(`/admin/node/${F}?/delete`, {});
check(folderCats > 0 && q('SELECT count(*) AS n FROM categories WHERE parent_id = ?', F)[0].n === 0, 'slettet mappe: kategoriene er borte');

if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(failures ? `\n${failures} FEIL` : '\nAlle sjekker ok');
process.exit(failures ? 1 : 0);
