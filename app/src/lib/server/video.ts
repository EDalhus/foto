import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { env } from '$env/dynamic/private';

/**
 * Video med ffmpeg: kjenne igjen videofiler, lese lengde og mål (ffprobe), hente et stillbilde til miniatyrene,
 * og lage en avspillingsversjon (H.264/AAC i MP4, maks 1080p) som spilles av i alle nettlesere.
 * Originalen røres aldri – den lagres og lastes ned som den er.
 */

const FFMPEG = () => env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => env.FFPROBE_PATH || 'ffprobe';

/** Lengste side på avspillingsversjonen. */
export const WEB_EDGE = 1920;

export class UnsupportedVideoError extends Error {}

/** Det vi tar vare på om en video (lagres som JSON i photos.video). */
export interface VideoInfo {
	/** Sekunder. */
	duration: number;
	/** Visningsmål (etter rotasjon). */
	width: number;
	height: number;
	codec: string;
	pixFmt: string;
	fps: number | null;
	/** Bit per sekund for hele fila. */
	bitrate: number | null;
	audio: string | null;
	/** ffprobe sitt formatnavn, f.eks. «mov,mp4,m4a,3gp,3g2,mj2». */
	container: string;
	hdr: boolean;
	rotation: number;
	/** Opptakstid fra fila: veggklokke («2026-09-14T10:22:31») eller UTC med «Z» på slutten. */
	createdAt: string | null;
	make?: string;
	model?: string;
}

// --- Kjøre ffmpeg/ffprobe ---------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
}

class ToolMissingError extends Error {}

function runTool(cmd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; lowPriority?: boolean }): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		if (opts.lowPriority && child.pid) {
			try {
				os.setPriority(child.pid, 10);
			} catch {
				// ikke viktig
			}
		}
		const out: Buffer[] = [];
		let err = '';
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => {
			err = (err + d.toString('utf8')).slice(-4000);
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
		const onAbort = () => child.kill('SIGKILL');
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		child.on('error', (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			reject(e.code === 'ENOENT' ? new ToolMissingError(`${cmd} er ikke installert på serveren.`) : e);
		});
		child.on('close', (code, sig) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			if (code === 0) return resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: err });
			const why = opts.signal?.aborted ? 'avbrutt' : sig ? `stoppet (${sig})` : `kode ${code}`;
			const last = err.trim().split('\n').slice(-3).join(' ').slice(0, 400);
			reject(new Error(`${cmd} feilet (${why})${last ? `: ${last}` : ''}`));
		});
	});
}

let available: Promise<string | null> | null = null;

/** ffmpeg-versjonen, eller null hvis ffmpeg/ffprobe mangler. */
export function ffmpegVersion(): Promise<string | null> {
	available ??= (async () => {
		try {
			const [a] = await Promise.all([
				runTool(FFMPEG(), ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
				runTool(FFPROBE(), ['-hide_banner', '-version'], { timeoutMs: 10_000 })
			]);
			return /ffmpeg version (\S+)/.exec(a.stdout)?.[1] ?? 'ukjent versjon';
		} catch {
			available = null; // prøv igjen neste gang (f.eks. etter at ffmpeg er installert)
			return null;
		}
	})();
	return available;
}

let zscale: Promise<boolean> | null = null;
/** Kan ffmpeg gjøre om HDR til vanlig (SDR) video? Krever zscale-filteret. */
function hasZscale(): Promise<boolean> {
	zscale ??= runTool(FFMPEG(), ['-hide_banner', '-filters'], { timeoutMs: 10_000 }).then(
		(r) => /\szscale\s/.test(r.stdout),
		() => false
	);
	return zscale;
}

// --- Kjenne igjen video -----------------------------------------------------------------

// ISO-mediefiler med disse merkene er stillbilder (HEIC/AVIF), ikke video.
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'mif2', 'msf1', 'avif', 'avis', 'crx ']);

/** Ser fila ut som en video? Sjekker de første bytene (ftyp, Matroska/WebM, AVI, MPEG-TS/AVCHD, MPEG-PS). */
export async function looksLikeVideo(file: string): Promise<boolean> {
	const fh = await fsp.open(file, 'r');
	try {
		const buf = Buffer.alloc(400);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		const b = buf.subarray(0, bytesRead);
		if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return !IMAGE_BRANDS.has(b.toString('latin1', 8, 12));
		if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return true;
		if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI ') return true;
		if (b.length > 376 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return true; // .ts
		if (b.length > 388 && b[4] === 0x47 && b[196] === 0x47 && b[388] === 0x47) return true; // .mts/.m2ts
		if (b.length >= 4 && b.readUInt32BE(0) === 0x000001ba) return true; // .mpg
		return false;
	} finally {
		await fh.close();
	}
}

// --- ffprobe -----------------------------------------------------------------------------

type Json = Record<string, unknown>;
const num = (v: unknown) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};
const ratio = (v: unknown) => {
	const m = /^(\d+)[:/](\d+)$/.exec(String(v ?? ''));
	return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
};
const tag = (tags: unknown, ...keys: string[]) => {
	if (!tags || typeof tags !== 'object') return undefined;
	const t = tags as Record<string, unknown>;
	for (const k of keys) {
		const hit = Object.keys(t).find((x) => x.toLowerCase() === k.toLowerCase());
		if (hit && typeof t[hit] === 'string' && (t[hit] as string).trim()) return (t[hit] as string).trim();
	}
	return undefined;
};

export async function probe(file: string): Promise<VideoInfo> {
	let data: Json;
	try {
		const r = await runTool(FFPROBE(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
		data = JSON.parse(r.stdout) as Json;
	} catch (err) {
		if (err instanceof ToolMissingError) throw new UnsupportedVideoError('Video støttes ikke på denne serveren ennå (ffmpeg mangler).');
		throw new UnsupportedVideoError('Fila er ikke en video som kan leses.');
	}
	const streams = (Array.isArray(data.streams) ? data.streams : []) as Json[];
	const format = (data.format ?? {}) as Json;
	const v = streams.find((s) => s.codec_type === 'video' && (s.disposition as Json | undefined)?.attached_pic !== 1);
	if (!v || !num(v.width) || !num(v.height)) throw new UnsupportedVideoError('Fant ingen video i fila.');
	const duration = num(format.duration) ?? num(v.duration) ?? 0;
	if (!duration) throw new UnsupportedVideoError('Videoen har ingen lengde.');

	let rotation = 0;
	for (const sd of (Array.isArray(v.side_data_list) ? v.side_data_list : []) as Json[]) {
		if (typeof sd.rotation === 'number') rotation = sd.rotation;
	}
	if (!rotation) rotation = Number(tag(v.tags, 'rotate') ?? 0) || 0;
	rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;

	const sar = ratio(v.sample_aspect_ratio) ?? 1;
	let w = Math.round(Number(v.width) * (sar > 0 ? sar : 1));
	let h = Number(v.height);
	if (rotation === 90 || rotation === 270) [w, h] = [h, w];

	const transfer = String(v.color_transfer ?? '');
	const audio = streams.find((s) => s.codec_type === 'audio');
	// Apple skriver lokal tid med tidssone; ellers står UTC i creation_time.
	const apple = tag(format.tags, 'com.apple.quicktime.creationdate');
	const created = apple?.slice(0, 19) ?? tag(format.tags, 'creation_time') ?? tag(v.tags, 'creation_time') ?? null;
	return {
		duration,
		width: w,
		height: h,
		codec: String(v.codec_name ?? ''),
		pixFmt: String(v.pix_fmt ?? ''),
		fps: ratio(v.avg_frame_rate) ?? ratio(v.r_frame_rate),
		bitrate: num(format.bit_rate),
		audio: audio ? String(audio.codec_name ?? 'ukjent') : null,
		container: String(format.format_name ?? ''),
		hdr: transfer === 'arib-std-b67' || transfer === 'smpte2084',
		rotation,
		createdAt: created,
		make: tag(format.tags, 'com.apple.quicktime.make', 'make', 'com.android.manufacturer'),
		model: tag(format.tags, 'com.apple.quicktime.model', 'model', 'com.android.model')
	};
}

/** Filtype og MIME-type for originalen, ut fra containeren. */
export function containerType(info: VideoInfo, filename: string): { mime: string; ext: string } {
	const own = filename.toLowerCase().match(/\.[a-z0-9]{2,5}$/)?.[0] ?? '';
	const c = info.container;
	if (c.includes('mp4') || c.includes('mov')) {
		if (own === '.mov' || own === '.qt') return { mime: 'video/quicktime', ext: '.mov' };
		if (own === '.m4v') return { mime: 'video/x-m4v', ext: '.m4v' };
		return { mime: 'video/mp4', ext: '.mp4' };
	}
	if (c.includes('matroska')) return own === '.webm' ? { mime: 'video/webm', ext: '.webm' } : { mime: 'video/x-matroska', ext: '.mkv' };
	if (c.includes('avi')) return { mime: 'video/x-msvideo', ext: '.avi' };
	if (c.includes('mpegts')) return { mime: 'video/mp2t', ext: own === '.ts' ? '.ts' : '.mts' };
	if (c.includes('mpeg')) return { mime: 'video/mpeg', ext: '.mpg' };
	return { mime: 'application/octet-stream', ext: own || '.video' };
}

// --- Stillbilde og avspillingsversjon -----------------------------------------------------

// HDR (HLG/PQ) → vanlig video, så fargene ikke blir bleke i nettleseren.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/** Stillbilde fra videoen (PNG i full størrelse) – blir miniatyrene og plakaten før avspilling. */
export async function extractFrame(file: string, info: VideoInfo, out: string, at?: number): Promise<void> {
	const tonemap = info.hdr && (await hasZscale()) ? `${TONEMAP},` : '';
	const t = at ?? (info.duration > 2 ? Math.min(1, info.duration / 4) : 0);
	const attempt = (seek: number) =>
		runTool(
			FFMPEG(),
			['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', seek.toFixed(3), '-i', file, '-frames:v', '1', '-an', '-sn', '-dn',
				'-vf', `${tonemap}format=rgb24`, '-f', 'image2', '-c:v', 'png', out],
			{ timeoutMs: 120_000 }
		);
	try {
		await attempt(t);
		const s = await fsp.stat(out).catch(() => null);
		if (s && s.size > 0) return;
	} catch (err) {
		if (err instanceof ToolMissingError) throw new UnsupportedVideoError('Video støttes ikke på denne serveren ennå (ffmpeg mangler).');
		if (t === 0) throw err;
	}
	await attempt(0);
}

/** Kan originalen brukes som den er (bare pakkes om)? H.264 i vanlig 8-bit, ikke for stor, ikke rotert. */
export function canCopy(info: VideoInfo): boolean {
	return (
		(info.container.includes('mp4') || info.container.includes('mov')) &&
		info.codec === 'h264' &&
		(info.pixFmt === 'yuv420p' || info.pixFmt === 'yuvj420p') &&
		!info.hdr &&
		info.rotation === 0 &&
		Math.max(info.width, info.height) <= WEB_EDGE &&
		(!info.bitrate || info.bitrate <= 16_000_000) &&
		(!info.audio || info.audio === 'aac')
	);
}

/** Målene på avspillingsversjonen: maks WEB_EDGE på lengste side, partall (krav i H.264). */
export function webSize(info: VideoInfo): { w: number; h: number } {
	const f = Math.min(1, WEB_EDGE / Math.max(info.width, info.height));
	const even = (n: number) => Math.max(2, Math.round((n * f) / 2) * 2);
	return { w: even(info.width), h: even(info.height) };
}

/** Lager avspillingsversjonen i `out` (MP4 med «faststart», så den starter før hele fila er lastet). */
export async function makeWebVersion(file: string, info: VideoInfo, out: string, signal?: AbortSignal): Promise<'copy' | 'encode'> {
	const timeoutMs = 30 * 60_000 + info.duration * 10_000;
	const common = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'];
	if (canCopy(info)) {
		try {
			await runTool(FFMPEG(), [...common, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out], { timeoutMs, signal, lowPriority: true });
			return 'copy';
		} catch (err) {
			if (signal?.aborted || err instanceof ToolMissingError) throw err;
			// Noe i fila liker ikke å bli pakket om – kod den på nytt i stedet.
		}
	}
	const { w, h } = webSize(info);
	const tonemap = info.hdr && (await hasZscale()) ? `${TONEMAP},` : '';
	const threads = String(Math.max(1, Math.min(3, os.availableParallelism() - 1)));
	const audio = info.audio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : [];
	await runTool(
		FFMPEG(),
		[...common, '-vf', `${tonemap}scale=${w}:${h}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
			'-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-fpsmax', '60', ...audio, '-movflags', '+faststart', '-threads', threads, '-f', 'mp4', out],
		{ timeoutMs, signal, lowPriority: true }
	);
	return 'encode';
}
