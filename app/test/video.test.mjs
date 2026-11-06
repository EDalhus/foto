// Ende-til-ende-test av video: opplasting i biter, stillbilde og avspillingsversjon (ffmpeg), avspilling med Range,
// nedlasting av originalen, ny versjon og sletting. Krever ffmpeg og ffprobe lokalt.
//
//   cd app && npm run build && node test/video.test.mjs
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-video-'));
const MEDIA = path.join(WORK, 'media');
fs.mkdirSync(MEDIA);
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

// --- Testfilene ----------------------------------------------------------------------------
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
const probe = (file) =>
	JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
// H.264 + AAC i 720p: kan pakkes om uten ny koding.
ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
	'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(MEDIA, 'klipp.mp4'));
// ProRes i 1440p uten lyd: må kodes om og skaleres ned til 1080p.
ff('-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=25', '-t', '2', '-c:v', 'prores_ks', '-profile:v', '0', path.join(MEDIA, 'drone.mov'));
// Stående video (rotasjon i metadata).
ff('-display_rotation:v:0', '90', '-i', path.join(MEDIA, 'klipp.mp4'), '-c', 'copy', path.join(MEDIA, 'staaende.mp4'));
// Ser ut som MP4, men er søppel.
fs.writeFileSync(path.join(MEDIA, 'odelagt.mp4'), Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), crypto.randomBytes(5000)]));
const file = (name) => fs.readFileSync(path.join(MEDIA, name));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
		BODY_SIZE_LIMIT: '80M',
		MAX_VIDEO_MB: '50',
		NODE_NO_WARNINGS: '1'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const cleanup = () => {
	server.kill();
	fs.rmSync(WORK, { recursive: true, force: true });
};
process.on('exit', cleanup);
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
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await wait(200);
	}
	return false;
}

// --- Innlogging ---------------------------------------------------------------------------------
let cookie = '';
async function req(method, url, { body, headers = {}, auth = true } = {}) {
	const h = { Origin: BASE, ...headers };
	if (auth && cookie) h.Cookie = cookie;
	const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
	for (const c of res.headers.getSetCookie?.() ?? []) {
		const [pair] = c.split(';');
		if (pair.startsWith('foto_session=')) cookie = pair;
	}
	return res;
}
const json = async (res) => {
	try {
		return await res.json();
	} catch {
		return null;
	}
};
const form = (o) => new URLSearchParams(o);
await req('POST', '/login?/password', { body: form(ADMIN), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' } });
const node = (slug) => q('SELECT id FROM nodes WHERE slug = ?', slug)[0]?.id;
const create = (o) => req('POST', '/admin?/create', { body: form(o), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' } });
await create({ name: 'Film', type: 'album', visibility: 'public' });
await create({ name: 'Hemmelig film', type: 'album', visibility: 'private' });
const film = node('film');
const hemmelig = node('hemmelig-film');
const row = (id) => q('SELECT * FROM photos WHERE id = ?', id)[0];

/** Laster opp i biter som Lightroom gjør. Returnerer svaret fra «complete». */
async function chunked(albumId, name, buf, { chunk = Math.ceil(buf.length / 3), meta = {}, replaceId } = {}) {
	const start = await req('POST', '/api/v1/uploads', {
		body: JSON.stringify({ albumId, filename: name, size: buf.length, replaceId, ...meta }),
		headers: { 'content-type': 'application/json' }
	});
	const s = await json(start);
	if (start.status !== 201) return { status: start.status, body: s };
	for (let off = 0; off < buf.length; off += chunk) {
		const r = await req('PUT', `/api/v1/uploads/${s.id}?offset=${off}`, { body: buf.subarray(off, off + chunk), headers: { 'content-type': 'application/octet-stream' } });
		if (r.status !== 200) return { status: r.status, body: await json(r), upload: s.id };
	}
	const done = await req('POST', `/api/v1/uploads/${s.id}/complete`);
	return { status: done.status, body: await json(done), upload: s.id };
}

// --- 1. Opplasting i biter ----------------------------------------------------------------------
console.log('1. Opplasting i biter');
const klipp = file('klipp.mp4');
const third = Math.ceil(klipp.length / 3);
let r = await req('POST', '/api/v1/uploads', {
	body: JSON.stringify({ albumId: film, filename: 'Klipp fra båten.mp4', size: klipp.length, title: 'Til kai', takenAt: '2026-09-14T10:22:31' }),
	headers: { 'content-type': 'application/json' }
});
const up = await json(r);
check(r.status === 201 && up.chunkSize === 32 * 1024 * 1024 && up.received === 0, 'start: får ID og bitstørrelse (32 MB)');
const put = (off, buf) => req('PUT', `/api/v1/uploads/${up.id}?offset=${off}`, { body: buf, headers: { 'content-type': 'application/octet-stream' } });
r = await put(0, klipp.subarray(0, third));
check(r.status === 200 && (await json(r)).received === third, 'første bit tatt imot');
r = await put(0, klipp.subarray(0, third));
check(r.status === 200 && (await json(r)).received === third, 'samme bit sendt på nytt går fint');
r = await put(third * 2, klipp.subarray(third * 2));
let body = await json(r);
check(r.status === 409 && body.received === third, 'bit for langt fram avvises med hvor mye serveren har');
r = await req('POST', `/api/v1/uploads/${up.id}/complete`);
check(r.status === 409, 'kan ikke fullføre før alt er sendt');
r = await put(third, Buffer.concat([klipp.subarray(third), Buffer.alloc(10)]));
check(r.status === 400, 'mer data enn fila skulle være, avvises');
r = await put(third, klipp.subarray(third, third * 2));
check(r.status === 200, 'andre bit');
r = await put(third * 2, klipp.subarray(third * 2));
check(r.status === 200 && (await json(r)).received === klipp.length, 'siste bit');
r = await req('POST', `/api/v1/uploads/${up.id}/complete`);
body = await json(r);
check(r.status === 201 && body.kind === 'video' && /\/i\//.test(body.url), 'fullført: en video i albumet');
const vid = body.id;
r = await req('POST', `/api/v1/uploads/${up.id}/complete`);
check(r.status === 200 && (await json(r)).id === vid, 'fullføre på nytt gir samme video (trygt å prøve igjen)');
let v = row(vid);
check(v.kind === 'video' && v.mime === 'video/mp4' && Math.abs(v.duration - 3) < 0.2, 'lagret som video (MP4, 3 sekunder)');
check(v.width === 1280 && v.height === 720 && v.title === 'Til kai', 'mål og tittel');
check(v.taken_at === Date.UTC(2026, 8, 14, 10, 22, 31), 'opptakstiden fra Lightroom brukes');
check(v.sha256 === sha(klipp) && v.bytes === klipp.length, 'sjekksum og størrelse stemmer');
check(JSON.parse(v.sizes).some((s) => s.name === 'm') && !!v.color, 'stillbilde og miniatyrer er laget');
let img = await req('GET', `/media/${vid}/1/m.webp`, { auth: false });
check(img.status === 200 && img.headers.get('content-type') === 'image/webp', 'miniatyren vises (offentlig album)');

// --- 2. Avspillingsversjon -----------------------------------------------------------------------
console.log('2. Avspillingsversjon');
check(v.original_state === 'pending', 'originalen venter til avspillingsversjonen er laget');
check(await until(() => row(vid).video_state === 'ready'), 'avspillingsversjonen blir klar');
check(await until(() => row(vid).original_state === 'stored', 10_000), 'så sendes originalen til lagringen');
check(/Video klar: Klipp fra båten\.mp4 \(pakket om/.test(serverLog), 'H.264 i 720p pakkes bare om (ingen ny koding)');
let res = await req('GET', `/media/${vid}/1/video.mp4`, { auth: false });
const web = Buffer.from(await res.arrayBuffer());
check(res.status === 200 && res.headers.get('content-type') === 'video/mp4' && res.headers.get('accept-ranges') === 'bytes', 'spilles av: video/mp4 med Range-støtte');
check(web.indexOf('moov') > 0 && web.indexOf('moov') < web.indexOf('mdat'), '«faststart»: kan starte før hele fila er lastet');
fs.writeFileSync(path.join(WORK, 'web.mp4'), web);
let p = probe(path.join(WORK, 'web.mp4'));
check(p.streams.some((s) => s.codec_name === 'h264') && p.streams.some((s) => s.codec_name === 'aac'), 'H.264 og AAC');
check(!JSON.stringify(p.format.tags ?? {}).includes('Til kai'), 'metadata er fjernet fra avspillingsversjonen');
res = await req('GET', `/media/${vid}/1/video.mp4`, { auth: false, headers: { range: 'bytes=0-1' } });
check(res.status === 206 && res.headers.get('content-range') === `bytes 0-1/${web.length}` && (await res.arrayBuffer()).byteLength === 2, 'Range: bytes=0-1 (Safari spør slik først)');
res = await req('GET', `/media/${vid}/1/video.mp4`, { auth: false, headers: { range: 'bytes=-100' } });
check(res.status === 206 && (await res.arrayBuffer()).byteLength === 100, 'Range: de siste 100 byte');
res = await req('GET', `/media/${vid}/1/video.mp4`, { auth: false, headers: { range: `bytes=${web.length}-` } });
check(res.status === 416, 'Range utenfor fila gir 416');
res = await req('GET', `/media/${vid}/9/video.mp4`, { auth: false });
check(res.status === 302 && res.headers.get('location') === `/media/${vid}/1/video.mp4`, 'gammel versjon i adressen sendes videre');

// --- 3. Albumet og nedlasting ------------------------------------------------------------------------
console.log('3. Albumet og nedlasting');
let html = await (await req('GET', '/film', { auth: false })).text();
check(html.includes(`/media/${vid}/1/video.mp4`) && html.includes('"video"'), 'albumsiden har videoen');
res = await req('GET', `/download/photo/${vid}`);
const orig = Buffer.from(await res.arrayBuffer());
check(res.status === 200 && res.headers.get('content-type') === 'video/mp4' && sha(orig) === sha(klipp), 'originalen lastes ned uendret');
check(/filename\*=UTF-8''Klipp%20fra%20b%C3%A5ten\.mp4/.test(res.headers.get('content-disposition') ?? ''), 'med opprinnelig filnavn');

// --- 4. Kodes om: stor ProRes og stående video ----------------------------------------------------------
console.log('4. Andre formater');
let out = await chunked(film, 'drone.mov', file('drone.mov'));
check(out.status === 201, 'ProRes (.mov) lastet opp');
const drone = out.body.id;
v = row(drone);
check(v.mime === 'video/quicktime' && v.width === 2560 && v.height === 1440 && v.original_key.endsWith('.mov'), 'originalen beholdes som .mov i full størrelse');
check(await until(() => row(drone).video_state === 'ready'), 'avspillingsversjonen blir klar');
fs.writeFileSync(path.join(WORK, 'drone-web.mp4'), Buffer.from(await (await req('GET', `/media/${drone}/1/video.mp4`)).arrayBuffer()));
p = probe(path.join(WORK, 'drone-web.mp4'));
let vs = p.streams.find((s) => s.codec_type === 'video');
check(vs?.codec_name === 'h264' && vs.width === 1920 && vs.height === 1080 && vs.pix_fmt === 'yuv420p', 'kodet om til H.264 i 1920×1080');
check(!p.streams.some((s) => s.codec_type === 'audio'), 'ingen lyd når originalen ikke har lyd');
check(/Video klar: drone\.mov \(kodet om/.test(serverLog), 'loggen sier «kodet om»');

out = await chunked(film, 'staaende.mp4', file('staaende.mp4'), { chunk: 1e9 });
const portrait = out.body?.id;
v = portrait ? row(portrait) : {};
check(out.status === 201 && v.width === 720 && v.height === 1280, 'stående video: 720×1280 (rotasjonen tas med)');
check(await until(() => row(portrait).video_state === 'ready'), 'avspillingsversjonen blir klar');
fs.writeFileSync(path.join(WORK, 'portrait-web.mp4'), Buffer.from(await (await req('GET', `/media/${portrait}/1/video.mp4`)).arrayBuffer()));
vs = probe(path.join(WORK, 'portrait-web.mp4')).streams.find((s) => s.codec_type === 'video');
check(vs?.width === 720 && vs?.height === 1280, 'avspillingsversjonen er stående (snudd riktig)');

// Liten video via vanlig opplasting (skjema), som fra nettsiden.
const fd = new FormData();
fd.append('file', new Blob([klipp], { type: 'video/mp4' }), 'liten.mp4');
res = await req('POST', `/api/v1/albums/${film}/photos`, { body: fd });
body = await json(res);
check(res.status === 201 && body.kind === 'video', 'liten video via vanlig opplasting');

// --- 5. Feil og tilgang ----------------------------------------------------------------------------------
console.log('5. Feil og tilgang');
out = await chunked(film, 'odelagt.mp4', file('odelagt.mp4'));
check(out.status === 415 && q('SELECT count(*) AS n FROM uploads WHERE id = ?', out.upload)[0].n === 0, 'ødelagt video avvises (415) og ryddes vekk');
const start = (o, opts) => req('POST', '/api/v1/uploads', { body: JSON.stringify(o), headers: { 'content-type': 'application/json' }, ...opts });
check((await start({ albumId: film, filename: 'x.mp4', size: 0 })).status === 400, 'størrelse 0 avvises');
r = await start({ albumId: film, filename: 'x.mp4', size: 60 * 1024 * 1024 });
check(r.status === 413 && /for stor/.test((await json(r))?.error ?? ''), 'for stor fil avvises (413)');
check((await start({ albumId: 'finnes-ikke', filename: 'x.mp4', size: 10 })).status === 404, 'ukjent album avvises');
check((await start({ albumId: film, filename: 'x.mp4', size: 10, replaceId: 'finnes-ikke' })).status === 404, 'erstatte noe som ikke finnes, avvises');
check((await start({ albumId: film, filename: 'x.mp4', size: 10 }, { auth: false })).status === 401, 'krever innlogging');
r = await fetch(`${BASE}/api/v1/uploads`, {
	method: 'POST',
	headers: { Cookie: cookie, Origin: 'https://evil.example', 'content-type': 'application/json' },
	body: JSON.stringify({ albumId: film, filename: 'x.mp4', size: 10 })
});
check(r.status === 403, 'fremmed side kan ikke starte opplasting (CSRF)');

out = await chunked(hemmelig, 'hemmelig.mp4', klipp);
const secret = out.body.id;
check(await until(() => row(secret).video_state === 'ready'), 'video i privat album blir klar');
check((await req('GET', `/media/${secret}/1/video.mp4`, { auth: false })).status === 404, 'privat video vises ikke for andre');
res = await req('GET', `/media/${secret}/1/video.mp4`);
check(res.status === 200 && /private/.test(res.headers.get('cache-control') ?? ''), 'administratoren ser den (privat mellomlagring)');

// --- 6. Ny versjon og sletting ---------------------------------------------------------------------------
console.log('6. Ny versjon og sletting');
out = await chunked(film, 'Klipp fra båten.mp4', file('drone.mov'), { replaceId: vid });
check(out.status === 201 && out.body.id === vid && row(vid).version === 2, 'ny versjon: samme ID, versjon 2');
check(await until(() => row(vid).video_state === 'ready'), 'ny avspillingsversjon blir klar');
check(!fs.existsSync(path.join(WORK, 'data/derived', vid, 'v1')), 'den gamle versjonen er ryddet bort');
res = await req('GET', `/media/${vid}/1/video.mp4`, { auth: false });
check(res.status === 302 && res.headers.get('location') === `/media/${vid}/2/video.mp4`, 'gammel adresse sendes til ny versjon');
const zip = await req('GET', `/download/album/${film}`);
const zipBuf = Buffer.from(await zip.arrayBuffer());
check(zip.status === 200 && zipBuf.includes(Buffer.from('drone.mov')) && zipBuf.includes(Buffer.from('liten.mp4')), 'videoene er med når hele albumet lastes ned');

r = await req('POST', `/admin/node/${film}?/deletePhotos`, {
	body: form({ photo: drone }),
	headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-sveltekit-action': 'true', accept: 'application/json' }
});
check(r.status === 200 && !row(drone) && !fs.existsSync(path.join(WORK, 'data/derived', drone)), 'slettet video: filene er borte');

if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(failures ? `\n${failures} FEIL` : '\nAlle sjekker ok');
process.exit(failures ? 1 : 0);
