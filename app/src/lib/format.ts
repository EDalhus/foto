import type { PhotoView } from './types';

const dateFmt = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('nb-NO', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC'
});
const monthFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const localFmt = new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Oslo' });

/** Opptaksdatoer lagres som veggklokke-tid i UTC (se server/images.ts). */
export const formatDate = (t: number | null | undefined) => (t ? dateFmt.format(t) : '');
export const formatDateTime = (t: number | null | undefined) => (t ? dateTimeFmt.format(t) : '');
export const formatMonth = (t: number | null | undefined) => (t ? monthFmt.format(t) : '');
const dayMonthYear = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortMonth = new Intl.DateTimeFormat('nb-NO', { month: 'short', timeZone: 'UTC' });
const shortMonthYear = new Intl.DateTimeFormat('nb-NO', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Kort periode: «25.–29. sep. 2024», «sep.–okt. 2023», «mar. 2012 – feb. 2026». */
export function formatRange(from: number, to: number) {
	const a = new Date(from);
	const b = new Date(to);
	const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
	const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
	if (to - from < 14 * 86400000 && sameMonth) {
		if (a.getUTCDate() === b.getUTCDate()) return dayMonthYear.format(a);
		return `${a.getUTCDate()}.–${dayMonthYear.format(b)}`;
	}
	if (sameMonth) return shortMonthYear.format(a);
	if (sameYear) return `${shortMonth.format(a)}–${shortMonthYear.format(b)}`;
	return `${shortMonthYear.format(a)} – ${shortMonthYear.format(b)}`;
}

/** Vanlige tidsstempler (opplastet, sist brukt osv.) vist i norsk tid. */
export const formatLocal = (t: number | null | undefined) => (t ? localFmt.format(t) : '–');

export function plural(n: number, one: string, many: string) {
	return `${n.toLocaleString('nb-NO')} ${n === 1 ? one : many}`;
}

export function formatBytes(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatShutter(s?: number) {
	if (!s) return '';
	if (s >= 1) return `${Number(s.toFixed(1))} s`;
	return `1/${Math.round(1 / s)} s`;
}

export function formatCamera(exif: PhotoView['exif']) {
	const make = (exif.make ?? '').replace(/\b(corporation|corp\.?|co\.?,? ?ltd\.?|imaging|company)\b/gi, '').trim();
	const model = (exif.model ?? '').trim();
	if (!model) return make;
	const firstWord = make.split(/\s+/)[0]?.toLowerCase();
	if (firstWord && model.toLowerCase().startsWith(firstWord)) return model;
	return make ? `${capitalize(make)} ${model}` : model;
}

function capitalize(s: string) {
	return s.length > 2 && s === s.toUpperCase() ? s[0] + s.slice(1).toLowerCase() : s;
}

export function formatExposure(exif: PhotoView['exif']) {
	return [
		exif.aperture ? `ƒ/${Number(exif.aperture.toFixed(1))}` : '',
		formatShutter(exif.shutter),
		exif.iso ? `ISO ${exif.iso}` : '',
		exif.focal ? `${Math.round(exif.focal)} mm` : ''
	]
		.filter(Boolean)
		.join(' · ');
}
