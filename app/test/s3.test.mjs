// Lagring i S3 (som `rclone serve s3` på UNAS): originalene strømmes til lagringen uten å leses inn i minnet,
// lastes ned med Range, slettes – og en video kan gjøres klar på nytt fra originalen i lagringen.
// Bruker en liten falsk S3-server. Krever ffmpeg lokalt.
//
//   cd app && npm run build && node test/s3.test.mjs
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-s3-'));
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
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await wait(200);
	}
	return false;
}

// --- Falsk S3 ----------------------------------------------------------------------------------
const objects = new Map(); // "bøtte/nøkkel" → Buffer
const puts = [];
const deletes = [];
const s3 = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
	const key = rest.join('/');
	const id = `${bucket}/${key}`;
	if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256')) {
		res.writeHead(403).end('<Error>signatur mangler</Error>');
		return;
	}
	if (req.method === 'PUT') {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			puts.push({ id, length: req.headers['content-length'], chunked: req.headers['transfer-encoding'] === 'chunked', payload: req.headers['x-amz-content-sha256'], bytes: body.length });
			objects.set(id, body);
			res.writeHead(200).end();
		});
		return;
	}
	if (req.method === 'DELETE') {
		deletes.push(id);
		objects.delete(id);
		res.writeHead(204).end();
		return;
	}
	if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
		const prefix = `${bucket}/${url.searchParams.get('prefix') ?? ''}`;
		const items = [...objects.keys()].filter((k) => k.startsWith(prefix));
		res.writeHead(200, { 'content-type': 'application/xml' }).end(
			`<ListBucketResult>${items.map((k) => `<Contents><Key>${k.slice(bucket.length + 1)}</Key><Size>${objects.get(k).length}</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`
		);
		return;
	}
	if (req.method === 'GET') {
		const obj = objects.get(id);
		if (!obj) {
			res.writeHead(404).end('<Error>NoSuchKey</Error>');
			return;
		}
		const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		if (m) {
			const start = Number(m[1]);
			const end = m[2] ? Math.min(Number(m[2]), obj.length - 1) : obj.length - 1;
			res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${obj.length}` }).end(obj.subarray(start, end + 1));
		} else res.writeHead(200, { 'content-length': obj.length }).end(obj);
		return;
	}
	res.writeHead(405).end();
});
const S3_PORT = await freePort();
await new Promise((r) => s3.listen(S3_PORT, '127.0.0.1', r));

// --- Server ----------------------------------------------------------------------------------------
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
		STORAGE_DRIVER: 's3',
		S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
		S3_ACCESS_KEY_ID: 'test',
		S3_SECRET_ACCESS_KEY: 'hemmelig',
		S3_BUCKET: 'originaler',
		BODY_SIZE_LIMIT: '80M',
		NODE_NO_WARNINGS: '1'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
process.on('exit', () => {
	server.kill();
	s3.close();
	fs.rmSync(WORK, { recursive: true, force: true });
});
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`${BASE}/health`)).ok) break;
	} catch {}
	await wait(100);
}
const dbFile = path.join(WORK, 'data/foto.db');
const q = (sql, ...p) => {
	const d = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return d.prepare(sql).all(...p);
	} finally {
		d.close();
	}
};
let cookie = '';
async function req(method, url, { body, headers = {} } = {}) {
	const res = await fetch(BASE + url, { method, body, redirect: 'manual', headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...headers } });
	for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith('foto_session=')) cookie = c.split(';')[0];
	return res;
}
await req('POST', '/login?/password', { body: new URLSearchParams(ADMIN), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' } });
await req('POST', '/admin?/create', { body: new URLSearchParams({ name: 'Lager', type: 'album', visibility: 'public' }), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' } });
const album = q(`SELECT id FROM nodes WHERE slug = 'lager'`)[0].id;
const row = (id) => q('SELECT * FROM photos WHERE id = ?', id)[0];

// --- 1. Video til lagringen --------------------------------------------------------------------------
console.log('1. Video til lagringen');
const clip = path.join(WORK, 'klipp.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
const buf = fs.readFileSync(clip);
const start = await (await req('POST', '/api/v1/uploads', { body: JSON.stringify({ albumId: album, filename: 'klipp.mp4', size: buf.length }), headers: { 'content-type': 'application/json' } })).json();
for (let off = 0; off < buf.length; off += start.chunkSize) {
	await req('PUT', `/api/v1/uploads/${start.id}?offset=${off}`, { body: buf.subarray(off, off + start.chunkSize), headers: { 'content-type': 'application/octet-stream' } });
}
const done = await (await req('POST', `/api/v1/uploads/${start.id}/complete`)).json();
const vid = done.id;
check(await until(() => row(vid)?.video_state === 'ready'), 'avspillingsversjonen er laget');
check(await until(() => row(vid)?.original_state === 'stored', 20_000), 'originalen er sendt til lagringen');
const put = puts.find((p) => p.id === `originaler/${row(vid).original_key}`);
check(put && put.bytes === buf.length && Number(put.length) === buf.length && !put.chunked, 'sendt med Content-Length (ikke «chunked»), alle byte kom fram');
check(put?.payload === 'UNSIGNED-PAYLOAD', 'signert som UNSIGNED-PAYLOAD (kroppen strømmes)');
check(!fs.existsSync(path.join(WORK, 'data/pending', `${vid}_v1.mp4`)), 'den lokale kopien er ryddet bort');
let res = await req('GET', `/download/photo/${vid}`);
const got = Buffer.from(await res.arrayBuffer());
check(res.status === 200 && got.equals(buf), 'originalen lastes ned fra lagringen, uendret');
res = await req('GET', `/download/photo/${vid}`, { headers: { range: 'bytes=100-199' } });
check(res.status === 206 && (await res.arrayBuffer()).byteLength === 100, 'Range mot lagringen');

// --- 2. Ny avspillingsversjon fra originalen i lagringen ---------------------------------------------------
console.log('2. Avspillingsversjon fra lagringen');
fs.rmSync(path.join(WORK, 'data/derived', vid, 'v1', 'video.mp4'), { force: true });
{
	const d = new DatabaseSync(dbFile);
	d.exec('PRAGMA busy_timeout = 5000');
	d.prepare(`UPDATE photos SET video_state = 'failed', video_attempts = 3 WHERE id = ?`).run(vid);
	d.close();
}
res = await req('POST', `/admin/node/${album}?/retryVideo`, {
	body: new URLSearchParams({ photo: vid }),
	headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-sveltekit-action': 'true', accept: 'application/json' }
});
check(res.status === 200 && (await res.json()).type === 'success', '«Prøv igjen»');
check(await until(() => row(vid)?.video_state === 'ready'), 'klar igjen – laget fra originalen i lagringen');
check(fs.existsSync(path.join(WORK, 'data/derived', vid, 'v1', 'video.mp4')), 'avspillingsversjonen finnes på serveren');
check(fs.readdirSync(path.join(WORK, 'data/tmp')).every((f) => !f.startsWith('video-')), 'den midlertidige kopien er ryddet bort');

// --- 3. Bilde og sletting ------------------------------------------------------------------------------------
console.log('3. Bilde og sletting');
const fd = new FormData();
fd.append('file', new Blob([await sharp({ create: { width: 200, height: 100, channels: 3, background: '#335577' } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'bilde.jpg');
const photo = (await (await req('POST', `/api/v1/albums/${album}/photos`, { body: fd })).json()).id;
check(await until(() => row(photo)?.original_state === 'stored', 20_000), 'bildet er i lagringen');
const zip = await req('GET', `/download/album/${album}`);
const zipBuf = Buffer.from(await zip.arrayBuffer());
check(zip.status === 200 && zipBuf.includes(Buffer.from('klipp.mp4')) && zipBuf.includes(Buffer.from('bilde.jpg')), 'hele albumet som zip, fra lagringen');
const key = `originaler/${row(vid).original_key}`;
await req('POST', `/admin/node/${album}?/deletePhotos`, {
	body: new URLSearchParams({ photo: vid }),
	headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-sveltekit-action': 'true', accept: 'application/json' }
});
check(await until(() => deletes.includes(key), 30_000) && !objects.has(key), 'slettet video: fjernet fra lagringen');

if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(failures ? `\n${failures} FEIL` : '\nAlle sjekker ok');
process.exit(failures ? 1 : 0);
