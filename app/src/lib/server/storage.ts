import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';
import { config } from './config';

/**
 * Lagring av originaler (og database-backup). To drivere:
 *  - local: vanlige filer i en mappe
 *  - s3:    alt som snakker S3 – f.eks. `rclone serve s3` på en NAS, Cloudflare R2 eller MinIO
 */

export interface GetResult {
	body: ReadableStream<Uint8Array>;
	/** Lengden på det som sendes (hele fila, eller utsnittet ved Range). */
	length: number;
	/** Total filstørrelse. */
	total: number;
	partial: boolean;
	start: number;
	end: number;
}

export interface ListedObject {
	key: string;
	size: number;
	lastModified: number;
}

export interface Store {
	readonly label: string;
	put(key: string, filePath: string, contentType: string): Promise<void>;
	get(key: string, range?: { start: number; end?: number }): Promise<GetResult | null>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<ListedObject[]>;
	/** Kaster hvis lagringen ikke kan nås. */
	health(): Promise<void>;
}

export class StoreUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'StoreUnavailableError';
	}
}

function assertKey(key: string) {
	if (!key || key.startsWith('/') || key.split('/').some((p) => p === '' || p === '.' || p === '..')) {
		throw new Error(`Ugyldig nøkkel: ${key}`);
	}
}

// ---------------------------------------------------------------------------

class LocalStore implements Store {
	readonly label: string;
	constructor(private root: string) {
		this.label = `Lokal disk (${root})`;
	}

	private file(key: string) {
		assertKey(key);
		return path.join(this.root, ...key.split('/'));
	}

	async put(key: string, filePath: string) {
		const target = this.file(key);
		await fsp.mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.tmp`;
		await fsp.copyFile(filePath, tmp);
		await fsp.rename(tmp, target);
	}

	async get(key: string, range?: { start: number; end?: number }): Promise<GetResult | null> {
		const file = this.file(key);
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(file);
		} catch {
			return null;
		}
		const total = stat.size;
		const start = range ? Math.min(range.start, Math.max(total - 1, 0)) : 0;
		const end = range ? Math.min(range.end ?? total - 1, total - 1) : total - 1;
		const stream = fs.createReadStream(file, { start, end });
		return {
			body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
			length: end - start + 1,
			total,
			partial: !!range,
			start,
			end
		};
	}

	async delete(key: string) {
		await fsp.rm(this.file(key), { force: true });
	}

	async list(prefix: string): Promise<ListedObject[]> {
		const out: ListedObject[] = [];
		const walk = async (dir: string, rel: string) => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) await walk(path.join(dir, e.name), r);
				else if (r.startsWith(prefix)) {
					const s = await fsp.stat(path.join(dir, e.name));
					out.push({ key: r, size: s.size, lastModified: s.mtimeMs });
				}
			}
		};
		await walk(this.root, '');
		return out;
	}

	async health() {
		await fsp.mkdir(this.root, { recursive: true });
		await fsp.access(this.root, fs.constants.W_OK);
	}
}

// ---------------------------------------------------------------------------

/** fetch med tidsavbrudd bare fram til svaret starter – selve nedlastingen kan ta så lang tid den trenger. */
async function fetchWithHeaderTimeout(req: Request, ms: number): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
	try {
		return await fetch(req, { signal: ctrl.signal });
	} catch (err) {
		throw new StoreUnavailableError(`Lagringen svarer ikke (${(err as Error).message})`, { cause: err });
	} finally {
		clearTimeout(timer);
	}
}

class S3Store implements Store {
	readonly label: string;
	private client: AwsClient;

	constructor(
		private endpoint: string,
		private bucket: string,
		region: string,
		accessKeyId: string,
		secretAccessKey: string
	) {
		this.label = `S3 (${endpoint}/${bucket})`;
		this.client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
	}

	private url(key = '', query = '') {
		if (key) assertKey(key);
		const encoded = key
			.split('/')
			.map((p) => encodeURIComponent(p))
			.join('/');
		return `${this.endpoint}/${encodeURIComponent(this.bucket)}${key ? `/${encoded}` : ''}${query}`;
	}

	private async send(url: string, init: RequestInit, timeoutMs = 15_000) {
		const req = await this.client.sign(url, init as never);
		return fetchWithHeaderTimeout(req, timeoutMs);
	}

	async put(key: string, filePath: string, contentType: string) {
		// Strømmes rett fra disk: en video på flere GB skal ikke ligge i minnet (beholderen har 2 GB).
		// aws4fetch signerer S3-kall med UNSIGNED-PAYLOAD, så kroppen trenger ikke leses på forhånd.
		const { size } = await fsp.stat(filePath);
		const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
		const res = await this.send(
			this.url(key),
			{ method: 'PUT', body, duplex: 'half', headers: { 'content-type': contentType, 'content-length': String(size) } } as RequestInit,
			// Tiden fram til svaret kommer, gjelder hele opplastingen: minst 10 minutter, mer for store filer.
			Math.max(10 * 60_000, (size / (2 * 1024 * 1024)) * 1000)
		);
		if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
		await res.arrayBuffer().catch(() => {});
	}

	async get(key: string, range?: { start: number; end?: number }): Promise<GetResult | null> {
		const headers: Record<string, string> = {};
		if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;
		const res = await this.send(this.url(key), { method: 'GET', headers });
		if (res.status === 404) {
			await res.arrayBuffer().catch(() => {});
			return null;
		}
		if (!res.ok || !res.body) throw new Error(`S3 GET ${key}: ${res.status}`);
		const length = Number(res.headers.get('content-length') ?? 0);
		// rclone svarer 200 (ikke 206) på Range, men med content-range – stol på den headeren.
		if (range || res.status === 206) {
			const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get('content-range') ?? '');
			if (m) {
				return {
					body: res.body,
					length,
					total: Number(m[3]),
					partial: true,
					start: Number(m[1]),
					end: Number(m[2])
				};
			}
		}
		// Serveren ignorerte Range – send hele fila.
		return { body: res.body, length, total: length, partial: false, start: 0, end: length - 1 };
	}

	async delete(key: string) {
		const res = await this.send(this.url(key), { method: 'DELETE' });
		await res.arrayBuffer().catch(() => {});
		if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
	}

	async list(prefix: string): Promise<ListedObject[]> {
		const out: ListedObject[] = [];
		let token = '';
		for (let page = 0; page < 1000; page++) {
			const q = new URLSearchParams({ 'list-type': '2', prefix });
			if (token) q.set('continuation-token', token);
			const res = await this.send(this.url('', `?${q}`), { method: 'GET' });
			const xml = await res.text();
			if (!res.ok) throw new Error(`S3 LIST: ${res.status} ${xml.slice(0, 300)}`);
			for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
				const block = m[1];
				const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '');
				const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0);
				const lastModified = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? '') || 0;
				if (key) out.push({ key, size, lastModified });
			}
			const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
			token = decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '');
			if (!truncated || !token) break;
		}
		return out;
	}

	async health() {
		const res = await this.send(this.url('', '?list-type=2&max-keys=1'), { method: 'GET' }, 6_000);
		const text = await res.text();
		if (!res.ok) throw new StoreUnavailableError(`Lagringen svarte ${res.status}: ${text.slice(0, 200)}`);
	}
}

function decodeXml(s: string) {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------

function make(bucket: string): Store {
	const s = config.storage;
	if (s.driver === 's3') {
		if (!s.s3.endpoint || !s.s3.accessKeyId || !s.s3.secretAccessKey) {
			throw new Error('STORAGE_DRIVER=s3 krever S3_ENDPOINT, S3_ACCESS_KEY_ID og S3_SECRET_ACCESS_KEY');
		}
		return new S3Store(s.s3.endpoint, bucket, s.s3.region, s.s3.accessKeyId, s.s3.secretAccessKey);
	}
	return new LocalStore(path.join(s.localDir, bucket));
}

let originals: Store | undefined;
let backups: Store | null | undefined;

export function originalStore(): Store {
	return (originals ??= make(config.storage.bucket));
}

/** Egen bøtte for database-backup, eller null hvis ikke satt opp. */
export function backupStore(): Store | null {
	if (backups === undefined) {
		backups = config.storage.backupBucket ? make(config.storage.backupBucket) : null;
	}
	return backups;
}
