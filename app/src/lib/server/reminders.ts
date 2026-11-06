/**
 * Påminnelse til gjester noen dager før «tilgang til og med» går ut. Hver gruppe får én påminnelse per dato
 * (groups.reminded_at nullstilles når datoen endres). Kjøres i bakgrunnen hver time.
 */
import { env } from '$env/dynamic/private';
import { all, one, run } from './db';
import { accessOf, createLoginToken, membersOf, type GroupRow } from './guests';
import { mailConfigured, reminderMail, sendMail } from './mail';
import { config } from './config';
import { getNode, HttpError } from './tree';

// Siste dag med tilgang, f.eks. «31. desember 2026» (expires_at er midnatt etter den dagen).
const lastDay = (expiresAt: number) =>
	new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Oslo' }).format(expiresAt - 1);

export interface ReminderSettings {
	enabled: boolean;
	days: number;
}

const DEFAULTS: ReminderSettings = { enabled: true, days: 3 };

export function getReminders(): ReminderSettings {
	const row = one<{ value: string }>(`SELECT value FROM settings WHERE key = 'reminders'`);
	try {
		return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveReminders(patch: { enabled: boolean; days: unknown }): ReminderSettings {
	const days = Number(patch.days);
	if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, 'Velg mellom 1 og 30 dager.');
	const next = { enabled: patch.enabled, days };
	run(
		`INSERT INTO settings (key, value) VALUES ('reminders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		JSON.stringify(next)
	);
	return next;
}

/** Sender påminnelsene som er forfalt. Returnerer antall e-poster som ble sendt. */
export async function sendDueReminders(t = Date.now()): Promise<number> {
	const s = getReminders();
	if (!s.enabled || !mailConfigured()) return 0;
	if (!config.origin) {
		console.warn('[foto] ORIGIN mangler – kan ikke sende påminnelser med lenke.');
		return 0;
	}
	const groups = all<GroupRow>(
		`SELECT * FROM groups WHERE expires_at IS NOT NULL AND reminded_at IS NULL AND expires_at > ? AND expires_at <= ?`,
		t,
		t + s.days * 86400_000
	);
	let sent = 0;
	for (const g of groups) {
		// Merk først: en feil i e-posten skal ikke gi en ny påminnelse hver time.
		run(`UPDATE groups SET reminded_at = ? WHERE id = ?`, t, g.id);
		const items = accessOf(g.id);
		const members = membersOf(g.id);
		if (!items.length || !members.length) continue;
		const next = items.length === 1 ? items[0].path : '/';
		const canDownload = g.download === 'yes' || (g.download === 'album' && items.some((i) => !!getNode(i.id)?.allow_download));
		for (const m of members) {
			const { token } = createLoginToken(m.id, 'invite');
			try {
				await sendMail(
					reminderMail({
						to: m.email,
						name: m.name,
						until: lastDay(g.expires_at!),
						items: items.map((i) => i.name),
						url: `${config.origin}/login/lenke/${token}?next=${encodeURIComponent(next)}`,
						canDownload
					})
				);
				sent++;
			} catch (err) {
				console.error(`[foto] Påminnelse til ${m.email} feilet:`, err);
			}
		}
	}
	if (sent) console.log(`[foto] Sendte ${sent} påminnelse${sent === 1 ? '' : 'r'} om at tilgangen går ut.`);
	return sent;
}

let started = false;

export function startReminders() {
	if (started) return;
	started = true;
	// Testene setter kortere tider.
	const every = Number(env.REMINDER_INTERVAL_MS) || 3600_000;
	const first = Number(env.REMINDER_FIRST_MS) || 120_000;
	const tick = () => void sendDueReminders().catch((err) => console.error('[foto] Påminnelser:', err));
	setTimeout(tick, first).unref();
	setInterval(tick, every).unref();
}

