import { json, type RequestEvent } from '@sveltejs/kit';
import { HttpError, isAdmin } from './tree';

/** Kjører en API-handler og gjør HttpError om til et JSON-svar. */
export async function api(fn: () => Promise<Response> | Response): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
		if (err && typeof err === 'object' && 'status' in err && 'body' in err) throw err; // SvelteKit error()/redirect()
		console.error('[foto] API-feil:', err);
		return json({ error: 'Intern feil' }, { status: 500 });
	}
}

export function requireAdmin(event: RequestEvent) {
	if (!event.locals.user) throw new HttpError(401, 'Ikke innlogget');
	if (!isAdmin(event.locals.user)) throw new HttpError(403, 'Ingen tilgang');
	return event.locals.user;
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new HttpError(400, 'Ugyldig JSON');
	}
}

/** Leser et multipart-skjema; gir en ryddig feilmelding hvis det ikke er det. */
export async function readForm(request: Request): Promise<FormData> {
	try {
		return await request.formData();
	} catch {
		throw new HttpError(400, 'Forventet multipart/form-data');
	}
}

export function optionalString(form: FormData, key: string): string | undefined {
	const v = form.get(key);
	return typeof v === 'string' ? v : undefined;
}

/** Content-Disposition med både ASCII-navn og UTF-8-navn (æøå). */
export function contentDisposition(filename: string, inline = false) {
	const ascii = filename
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\x20-\x7e]/g, '_')
		.replace(/["\\]/g, '_');
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Nøkkelord fra skjema: JSON-liste eller kommaseparert. undefined = ikke sendt. */
export function keywordsFrom(form: FormData): string[] | undefined {
	const raw = optionalString(form, 'keywords');
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		// kommaseparert
	}
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
