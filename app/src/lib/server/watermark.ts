import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { SessionUser } from './auth';
import { config } from './config';
import { one, run } from './db';
import { derivedDir } from './photos';
import { HttpError, isAdmin, type TreeNode } from './tree';

/**
 * Vannmerke på offentlige bilder. Administratoren og gjester som ser private album, får bildene uten.
 * Vannmerkede versjoner lages første gang noen ber om dem og lagres ved siden av de vanlige
 * (derived/<id>/v<n>/wm<rev>-m.webp). `rev` økes for hver endring, så nettlesere aldri viser en gammel versjon.
 */
export type WatermarkPosition = 'corner' | 'center';
export interface WatermarkSettings {
	enabled: boolean;
	text: string;
	position: WatermarkPosition;
	rev: number;
}

const DEFAULTS: WatermarkSettings = { enabled: false, text: '', position: 'corner', rev: 0 };
/** Størrelsene som får vannmerke. Små miniatyrer (s) lar vi være. */
export const WATERMARKED = new Set(['m.webp', 'l.webp', 'x.webp', 'og.jpg']);

let cached: WatermarkSettings | null = null;

export function getWatermark(): WatermarkSettings {
	if (cached) return cached;
	const row = one<{ value: string }>(`SELECT value FROM settings WHERE key = 'watermark'`);
	try {
		cached = { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
	} catch {
		cached = { ...DEFAULTS };
	}
	return cached!;
}

export function saveWatermark(patch: { enabled: boolean; text: unknown; position: unknown }): WatermarkSettings {
	const text = String(patch.text ?? '').replace(/\s+/g, ' ').trim();
	if (text.length > 60) throw new HttpError(400, 'Teksten er for lang (maks 60 tegn).');
	if (patch.enabled && !text) throw new HttpError(400, 'Skriv inn teksten som skal stå på bildene.');
	const current = getWatermark();
	const next: WatermarkSettings = {
		enabled: patch.enabled,
		text,
		position: patch.position === 'center' ? 'center' : 'corner',
		rev: current.rev + 1
	};
	run(
		`INSERT INTO settings (key, value) VALUES ('watermark', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		JSON.stringify(next)
	);
	cached = next;
	void removeOld(next.rev);
	return next;
}

/** Vannmerkeversjonen brukeren skal se for et bilde i dette albumet, eller null for uten. */
export function watermarkFor(album: TreeNode, user: SessionUser | null | undefined): number | null {
	const w = getWatermark();
	if (!w.enabled || !w.text || album.effectivePrivate || isAdmin(user)) return null;
	return w.rev;
}

export const wmName = (file: string, rev: number) => `wm${rev}-${file}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function overlay(w: number, h: number, s: WatermarkSettings): Buffer {
	const len = Math.max(4, s.text.length);
	let size: number, x: number, y: number, anchor: string, baseline: string, opacity: number;
	if (s.position === 'center') {
		size = Math.min(h * 0.1, (w * 0.8) / (0.6 * len));
		x = w / 2;
		y = h / 2;
		anchor = 'middle';
		baseline = 'central';
		opacity = 0.35;
	} else {
		size = Math.min(Math.min(w, h) * 0.035, (w * 0.6) / (0.6 * len));
		const margin = Math.max(8, size * 0.9);
		x = w - margin;
		y = h - margin;
		anchor = 'end';
		baseline = 'auto';
		opacity = 0.6;
	}
	size = Math.max(10, Math.round(size));
	const stroke = Math.max(1, size / 18).toFixed(1);
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="DejaVu Sans, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" ` +
			`text-anchor="${anchor}" dominant-baseline="${baseline}" fill="#ffffff" fill-opacity="${opacity}" stroke="#000000" stroke-opacity="${(opacity * 0.4).toFixed(2)}" stroke-width="${stroke}" paint-order="stroke">${esc(s.text)}</text></svg>`
	);
}

const inflight = new Map<string, Promise<string>>();

/** Stien til den vannmerkede fila – lager den hvis den ikke finnes. */
export function ensureWatermarked(photoId: string, version: number, file: string): Promise<string> {
	const s = getWatermark();
	const dir = derivedDir(photoId, version);
	const target = path.join(dir, wmName(file, s.rev));
	const existing = inflight.get(target);
	if (existing) return existing;
	const job = (async () => {
		if (await fsp.stat(target).catch(() => null)) return target;
		const src = path.join(dir, file);
		const img = sharp(src);
		const meta = await img.metadata();
		const w = meta.width ?? 0;
		const h = meta.height ?? 0;
		if (!w || !h) throw new Error(`Kan ikke lese ${src}`);
		const out = img.composite([{ input: overlay(w, h, s), top: 0, left: 0 }]);
		const tmp = `${target}.${randomUUID()}.tmp`;
		if (file.endsWith('.jpg')) await out.jpeg({ quality: 82, mozjpeg: true }).toFile(tmp);
		else await out.webp({ quality: 82, effort: 4, smartSubsample: true }).toFile(tmp);
		await fsp.rename(tmp, target);
		return target;
	})().finally(() => inflight.delete(target));
	inflight.set(target, job);
	return job;
}

/** Rydder bort vannmerkede filer fra tidligere innstillinger. */
async function removeOld(rev: number) {
	const keep = `wm${rev}-`;
	try {
		for (const id of await fsp.readdir(config.derivedDir)) {
			const photoDir = path.join(config.derivedDir, id);
			for (const v of await fsp.readdir(photoDir).catch(() => [])) {
				const vDir = path.join(photoDir, v);
				for (const f of await fsp.readdir(vDir).catch(() => [])) {
					if (f.startsWith('wm') && !f.startsWith(keep)) await fsp.rm(path.join(vDir, f), { force: true });
				}
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[foto] Rydding av gamle vannmerker feilet:', err);
	}
}
