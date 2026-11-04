import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';
import { config } from './config';
import { one } from './db';

/**
 * Sender e-post via SMTP (på foto.dalhus.net: en egen Postfix-container på serveren).
 *   SMTP_HOST / SMTP_PORT – f.eks. 127.0.0.1 / 2526
 *   SMTP_USER / SMTP_PASS – valgfritt
 *   SMTP_SECURE=true      – TLS fra start (port 465)
 *   MAIL_FROM             – f.eks. "Eirik Dalhus <noreply@dalhus.net>"
 * Uten SMTP_HOST skrives e-posten til loggen i stedet (lokal utvikling og tester).
 */
let transport: Transporter | null = null;

export function mailConfigured() {
	return !!env.SMTP_HOST;
}

function getTransport(): Transporter | null {
	if (!env.SMTP_HOST) return null;
	transport ??= nodemailer.createTransport({
		host: env.SMTP_HOST,
		port: Number(env.SMTP_PORT || 587),
		secure: env.SMTP_SECURE === 'true',
		auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
		// Lokal Postfix uten gyldig sertifikat.
		tls: { rejectUnauthorized: env.SMTP_TLS_VERIFY === 'true' }
	});
	return transport;
}

export interface Mail {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export async function sendMail(mail: Mail): Promise<void> {
	const t = getTransport();
	if (!t) {
		console.log(`[foto] E-post (ikke sendt, SMTP_HOST mangler) til ${mail.to}: ${mail.subject}\n${mail.text}`);
		return;
	}
	await t.sendMail({ from: env.MAIL_FROM || `${config.siteTitle} <noreply@localhost>`, ...mail });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Innloggings- eller invitasjonslenke. */
export function loginMail(opts: { to: string; name: string; url: string; invite: boolean; validFor: string }): Mail {
	const site = config.siteTitle;
	const hello = opts.name ? `Hei ${opts.name}!` : 'Hei!';
	const intro = opts.invite
		? `${site} har delt bilder med deg. Trykk på knappen for å se dem.`
		: `Her er lenken for å logge inn på ${site}.`;
	const button = opts.invite ? 'Se bildene' : 'Logg inn';
	const note = `Lenken virker i ${opts.validFor} og kan bare brukes én gang. Har du ikke bedt om den, kan du se bort fra denne e-posten.`;
	return {
		to: opts.to,
		subject: opts.invite ? `${site} har delt bilder med deg` : `Logg inn på ${site}`,
		text: `${hello}\n\n${intro}\n\n${opts.url}\n\n${note}\n`,
		html: `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1b1b1d">
<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<p style="margin:0 0 6px;font-size:13px;color:#6b6b70">${esc(site)}</p>
<h1 style="margin:0 0 16px;font-size:22px">${esc(hello)}</h1>
<p style="margin:0 0 22px;font-size:15px;line-height:1.5">${esc(intro)}</p>
<p style="margin:0 0 22px"><a href="${esc(opts.url)}" style="display:inline-block;background:#1b1b1d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(button)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b70">${esc(note)}</p>
</div></body></html>`
	};
}

/** Varsel til deg (administratoren). */
export function noticeMail(opts: { to: string; subject: string; heading: string; lines: string[]; url?: string; button?: string; list?: string }): Mail {
	const site = config.siteTitle;
	const textList = opts.list ? `\n${opts.list}\n` : '';
	return {
		to: opts.to,
		subject: opts.subject,
		text: `${opts.heading}\n\n${opts.lines.join('\n\n')}\n${textList}${opts.url ? `\n${opts.url}\n` : ''}`,
		html: `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1b1b1d">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<p style="margin:0 0 6px;font-size:13px;color:#6b6b70">${esc(site)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${esc(opts.heading)}</h1>
${opts.lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join('\n')}
${opts.list ? `<pre style="margin:0 0 18px;padding:12px;background:#f4f4f2;border-radius:8px;font-size:13px;white-space:pre-wrap;word-break:break-all">${esc(opts.list)}</pre>` : ''}
${opts.url ? `<p style="margin:8px 0 0"><a href="${esc(opts.url)}" style="display:inline-block;background:#1b1b1d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(opts.button ?? 'Åpne')}</a></p>` : ''}
</div></body></html>`
	};
}

/** Adressen varsler sendes til: NOTIFY_EMAIL, ellers administratorens e-post. */
function adminAddress(): string | null {
	if (env.NOTIFY_EMAIL === 'off') return null;
	return env.NOTIFY_EMAIL || one<{ email: string }>(`SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)?.email || null;
}

/** Sender et varsel i bakgrunnen. Feil logges, men stopper aldri det gjesten holder på med. */
export function notifyAdmin(build: (to: string) => Mail): void {
	const to = adminAddress();
	if (!to) return;
	sendMail(build(to)).catch((err) => console.error('[foto] Kunne ikke sende varsel:', err));
}
