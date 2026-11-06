/**
 * Statistikk per mappe/album: visninger og nedlastinger per dag, og hva hver gjest har sett og lastet ned.
 *
 * Personvern: ingen informasjonskapsler og ingen IP-adresser lagres. For å telle samme besøkende bare én gang per
 * halvtime brukes en hash av IP + nettleser med et tilfeldig salt som bare finnes i minnet (nytt ved hver omstart).
 * Administratoren og roboter (lenkeforhåndsvisning, søkemotorer) telles ikke.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SessionUser } from './auth';
import { all, one, run } from './db';
import { getTree, isAdmin, pathOf, type TreeNode } from './tree';

const SALT = randomBytes(16).toString('hex');
const DAY = 86400_000;
const VISIT_MS = 30 * 60_000;
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|curl|wget|python|go-http|headless|lighthouse/i;
const osloDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' });

/** Datoen i norsk tid, ÅÅÅÅ-MM-DD. */
export const dayOf = (t = Date.now()) => osloDay.format(t);
export const isBot = (ua: string | null) => !ua || BOTS.test(ua);

const lastSeen = new Map<string, number>();

function touchGuest(userId: string, nodeId: string, add: { views?: number; downloads?: number; zips?: number }, t: number) {
	run(
		`INSERT INTO guest_activity (user_id, node_id, views, downloads, zips, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, node_id) DO UPDATE SET views = views + excluded.views, downloads = downloads + excluded.downloads,
		 zips = zips + excluded.zips, last_at = excluded.last_at`,
		userId,
		nodeId,
		add.views ?? 0,
		add.downloads ?? 0,
		add.zips ?? 0,
		t,
		t
	);
}

/** En visning av en mappe eller et album. Samme besøkende telles én gang per halvtime. */
export function recordView(node: TreeNode, user: SessionUser | null, ip: string, ua: string | null): boolean {
	if (isAdmin(user) || isBot(ua)) return false;
	const t = Date.now();
	const who = user ? `u:${user.id}` : createHash('sha256').update(`${SALT}|${ip}|${ua}`).digest('base64url').slice(0, 22);
	const key = `${node.id}|${who}`;
	const last = lastSeen.get(key);
	if (last && t - last < VISIT_MS) return false;
	lastSeen.set(key, t);
	if (lastSeen.size > 50_000) for (const [k, v] of lastSeen) if (t - v > VISIT_MS) lastSeen.delete(k);
	run(`INSERT INTO node_stats (node_id, day, views) VALUES (?, ?, 1) ON CONFLICT (node_id, day) DO UPDATE SET views = views + 1`, node.id, dayOf(t));
	if (user) touchGuest(user.id, node.id, { views: 1 }, t);
	return true;
}

/** Et bilde i full oppløsning, eller hele albumet som zip. */
export function recordDownload(album: TreeNode, user: SessionUser | null, kind: 'photo' | 'zip') {
	if (isAdmin(user)) return;
	const t = Date.now();
	const photo = kind === 'photo' ? 1 : 0;
	run(
		`INSERT INTO node_stats (node_id, day, downloads, zips) VALUES (?, ?, ?, ?)
		 ON CONFLICT (node_id, day) DO UPDATE SET downloads = downloads + excluded.downloads, zips = zips + excluded.zips`,
		album.id,
		dayOf(t),
		photo,
		1 - photo
	);
	if (user) touchGuest(user.id, album.id, { downloads: photo, zips: 1 - photo }, t);
}

export interface Totals {
	views: number;
	downloads: number;
	zips: number;
}

const ZERO: Totals = { views: 0, downloads: 0, zips: 0 };
const sums = `coalesce(sum(views), 0) AS views, coalesce(sum(downloads), 0) AS downloads, coalesce(sum(zips), 0) AS zips`;

export type Period = 7 | 30 | 90 | 365;
export const PERIODS: Period[] = [7, 30, 90, 365];
export const periodOf = (v: unknown): Period => (PERIODS.includes(Number(v) as Period) ? (Number(v) as Period) : 30);

export interface Point extends Totals {
	/** ÅÅÅÅ-MM-DD (dag) eller ÅÅÅÅ-MM (måned). */
	key: string;
}

/** Tall per dag (eller per måned for et helt år), med null for dager uten noe. */
function series(where: string, args: unknown[], period: Period, t = Date.now()): Point[] {
	const monthly = period === 365;
	const from = dayOf(t - (period - 1) * DAY);
	const rows = all<Point>(
		`SELECT ${monthly ? 'substr(day, 1, 7)' : 'day'} AS key, ${sums} FROM node_stats WHERE day >= ? ${where} GROUP BY key ORDER BY key`,
		from,
		...args
	);
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const out: Point[] = [];
	if (monthly) {
		const d = new Date(`${dayOf(t)}T12:00:00Z`);
		for (let i = 11; i >= 0; i--) {
			const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15));
			const key = m.toISOString().slice(0, 7);
			out.push(byKey.get(key) ?? { key, ...ZERO });
		}
	} else {
		for (let i = period - 1; i >= 0; i--) {
			const key = dayOf(t - i * DAY);
			out.push(byKey.get(key) ?? { key, ...ZERO });
		}
	}
	return out;
}

export interface GuestRow {
	userId: string;
	name: string;
	email: string;
	nodeId: string;
	views: number;
	downloads: number;
	zips: number;
	firstAt: number;
	lastAt: number;
}

const guestSql = `SELECT g.user_id AS userId, u.name, u.email, g.node_id AS nodeId, g.views, g.downloads, g.zips, g.first_at AS firstAt, g.last_at AS lastAt
	FROM guest_activity g JOIN users u ON u.id = g.user_id`;

/** Oversikten under Administrer → Statistikk. */
export function overview(period: Period) {
	const t = Date.now();
	const from = dayOf(t - (period - 1) * DAY);
	const { byId } = getTree();
	const totals = one<Totals>(`SELECT ${sums} FROM node_stats WHERE day >= ?`, from) ?? ZERO;
	const top = all<Totals & { nodeId: string }>(
		`SELECT node_id AS nodeId, ${sums} FROM node_stats WHERE day >= ? GROUP BY node_id ORDER BY views DESC, downloads DESC LIMIT 100`,
		from
	)
		.map((r) => {
			const n = byId.get(r.nodeId);
			return n ? { ...r, name: n.name, type: n.type, path: pathOf(n), trail: trail(n) } : null;
		})
		.filter((r) => !!r);
	const sinceTs = t - period * DAY;
	const guests = all<GuestRow>(`${guestSql} WHERE g.last_at >= ? ORDER BY g.last_at DESC LIMIT 40`, sinceTs).map((g) => ({
		...g,
		node: byId.get(g.nodeId)?.name ?? ''
	}));
	const activeGuests = one<{ n: number }>(`SELECT count(DISTINCT user_id) AS n FROM guest_activity WHERE last_at >= ?`, sinceTs)?.n ?? 0;
	return { totals, series: series('', [], period, t), top, guests, activeGuests };
}

/** Til albumsiden: siste 30 dager, totalt, og hva hver gjest har gjort. */
export function nodeStats(nodeId: string) {
	const t = Date.now();
	return {
		last30: one<Totals>(`SELECT ${sums} FROM node_stats WHERE node_id = ? AND day >= ?`, nodeId, dayOf(t - 29 * DAY)) ?? ZERO,
		total: one<Totals>(`SELECT ${sums} FROM node_stats WHERE node_id = ?`, nodeId) ?? ZERO,
		series: series('AND node_id = ?', [nodeId], 30, t),
		guests: all<GuestRow>(`${guestSql} WHERE g.node_id = ? ORDER BY g.last_at DESC`, nodeId)
	};
}

function trail(n: TreeNode) {
	const parts: string[] = [];
	for (let p = n.parent; p; p = p.parent) parts.unshift(p.name);
	return parts.join(' / ');
}
