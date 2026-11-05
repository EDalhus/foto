/**
 * Hjelpere til «zoom» mellom et miniatyrbilde i rutenettet og bildevisningen.
 *
 * Bildet i visningen flyttes og skaleres (transform) så det dekker miniatyren, og beskjæres (clip-path)
 * til miniatyrens form – miniatyrene er litt beskåret (object-fit: cover), bildet i visningen er helt.
 */

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export const reducedMotion = () =>
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Kurver: rask start og myk landing når bildet åpnes, jevn når det lukkes. */
export const EASE_OPEN = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.2, 1)';

export const FULL: Keyframe = { transform: 'translate(0px, 0px) scale(1)', clipPath: 'inset(0px 0px 0px 0px round 0px)' };

/** Nøkkelrammen der et bilde som ligger i `full` ser ut som miniatyren `thumb`. */
export function thumbFrame(thumb: Box, full: Box, radius = 3): Keyframe {
	const s = Math.max(thumb.width / full.width, thumb.height / full.height);
	const dx = thumb.left + thumb.width / 2 - (full.left + full.width / 2);
	const dy = thumb.top + thumb.height / 2 - (full.top + full.height / 2);
	// clip-path gjelder før skaleringen, så innfellingen regnes i bildets egne mål.
	const ix = Math.max(0, (full.width - thumb.width / s) / 2);
	const iy = Math.max(0, (full.height - thumb.height / s) / 2);
	const r = radius / s;
	return {
		transform: `translate(${dx}px, ${dy}px) scale(${s})`,
		clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${r}px)`
	};
}

/** Er elementet (noenlunde) synlig i vinduet? */
export function onScreen(el: Element, margin = 0): boolean {
	const r = el.getBoundingClientRect();
	return r.bottom > margin && r.top < innerHeight - margin && r.right > 0 && r.left < innerWidth && r.width > 0;
}

/**
 * Rull siden (uten animasjon) så elementet er midt i vinduet – men bare hvis det ikke allerede er helt synlig.
 * Returnerer ny rulleposisjon.
 */
export function reveal(el: Element, topMargin = 72): number {
	const r = el.getBoundingClientRect();
	const fits = r.top >= topMargin && r.bottom <= innerHeight - 8;
	if (!fits) {
		const y = scrollY + r.top - Math.max(topMargin, (innerHeight - r.height) / 2);
		scrollTo({ top: Math.max(0, y), left: scrollX, behavior: 'instant' });
	}
	return scrollY;
}

/** Bildets kilde i rutenettet, hvis det er lastet – brukes som plassholder mens det store bildet lastes. */
export function loadedSrc(el: Element | null | undefined): string | null {
	const img = el?.querySelector('img');
	return img && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
}
