import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { ensureAdmin, purgeExpiredSessions, SESSION_COOKIE, userFromApiToken, userFromSession } from '$lib/server/auth';
import { startWorker } from '$lib/server/worker';

export const init: ServerInit = async () => {
	await ensureAdmin();
	purgeExpiredSessions();
	startWorker();
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.authVia = null;

	const auth = event.request.headers.get('authorization');
	if (auth?.startsWith('Bearer ')) {
		const user = userFromApiToken(auth.slice(7).trim());
		if (user) {
			event.locals.user = user;
			event.locals.authVia = 'token';
		}
	} else {
		const user = userFromSession(event.cookies.get(SESSION_COOKIE));
		if (user) {
			event.locals.user = user;
			event.locals.authVia = 'session';
		}
	}

	// CSRF: alt som endrer noe må komme fra vår egen side – unntatt kall med API-nøkkel
	// (en nettleser kan ikke sende Authorization-headeren fra en fremmed side).
	// «Koble til Foto» fra Lightroom bruker verken informasjonskapsel eller nøkkel, så CSRF er ikke relevant der.
	const { method } = event.request;
	const connectApi = event.url.pathname === '/api/v1/connect/start' || event.url.pathname === '/api/v1/connect/poll';
	if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !auth?.startsWith('Bearer ') && !connectApi) {
		const origin = event.request.headers.get('origin');
		if (!origin || origin !== event.url.origin) {
			const message = 'Forespørselen ble avvist (feil opprinnelse).';
			return event.request.headers.get('accept')?.includes('text/html')
				? new Response(message, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
				: new Response(JSON.stringify({ error: message }), { status: 403, headers: { 'content-type': 'application/json' } });
		}
	}

	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	if (event.locals.user && !response.headers.has('cache-control')) {
		response.headers.set('cache-control', 'private, no-store');
	}
	return response;
};

export const handleError: HandleServerError = ({ error, event, status }) => {
	if (status !== 404) console.error(`[foto] ${event.request.method} ${event.url.pathname}:`, error);
	return { message: status === 404 ? 'Finner ikke siden' : 'Noe gikk galt' };
};
