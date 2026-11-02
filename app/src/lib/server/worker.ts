import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';
import { all, db, one, run } from './db';
import { now } from './ids';
import { pendingFile, type PhotoRow } from './photos';
import { backupStore, originalStore, StoreUnavailableError } from './storage';

/**
 * Bakgrunnsjobber:
 *  - sender ventende originaler til lagringen (UNAS) og sletter den lokale kopien etterpå
 *  - sletter originaler som er fjernet (kø, så det tåler at UNAS er nede)
 *  - sjekker jevnlig at lagringen svarer
 *  - tar backup av databasen til lagringen
 */

export interface StoreHealth {
	ok: boolean | null;
	checkedAt: number | null;
	error: string | null;
	label: string;
}

const state = {
	started: false,
	running: false,
	again: false,
	health: { ok: null, checkedAt: null, error: null, label: '' } as StoreHealth,
	lastBackupAt: 0,
	lastBackupError: null as string | null
};

export function storeHealth(): StoreHealth {
	return { ...state.health };
}

export function backupStatus() {
	return { lastBackupAt: state.lastBackupAt || null, error: state.lastBackupError };
}

export async function checkHealth(): Promise<StoreHealth> {
	const store = originalStore();
	try {
		await store.health();
		state.health = { ok: true, checkedAt: now(), error: null, label: store.label };
	} catch (err) {
		state.health = { ok: false, checkedAt: now(), error: (err as Error).message, label: store.label };
	}
	return storeHealth();
}

/** Be arbeideren se etter nytt arbeid så snart som mulig. */
export function kickWorker() {
	if (!state.started) return;
	if (state.running) {
		state.again = true;
		return;
	}
	setImmediate(() => void tick());
}

async function tick() {
	if (state.running) return;
	state.running = true;
	try {
		do {
			state.again = false;
			if (state.health.ok === false) {
				await checkHealth();
				if (!state.health.ok) break;
			}
			const uploadedAny = await uploadPending();
			const deletedAny = await processDeletes();
			if (!uploadedAny && !deletedAny) break;
		} while (state.again);
	} catch (err) {
		console.error('[foto] arbeider:', err);
	} finally {
		state.running = false;
	}
}

async function uploadPending(): Promise<boolean> {
	const store = originalStore();
	const rows = all<PhotoRow>(
		`SELECT * FROM photos WHERE original_state = 'pending' ORDER BY original_attempts, created_at LIMIT 25`
	);
	let did = false;
	for (const row of rows) {
		const file = pendingFile(row);
		try {
			await fsp.access(file);
		} catch {
			run(
				`UPDATE photos SET original_error = ?, original_attempts = original_attempts + 1 WHERE id = ? AND version = ?`,
				'Den lokale kopien av originalen mangler.',
				row.id,
				row.version
			);
			continue;
		}
		try {
			await store.put(row.original_key, file, row.mime);
		} catch (err) {
			run(
				`UPDATE photos SET original_error = ?, original_attempts = original_attempts + 1 WHERE id = ? AND version = ?`,
				(err as Error).message.slice(0, 500),
				row.id,
				row.version
			);
			if (err instanceof StoreUnavailableError) {
				state.health = { ...state.health, ok: false, checkedAt: now(), error: err.message };
				return did;
			}
			continue;
		}
		const r = run(
			`UPDATE photos SET original_state = 'stored', original_error = NULL WHERE id = ? AND version = ? AND original_key = ?`,
			row.id,
			row.version,
			row.original_key
		);
		if (r.changes === 0) {
			// Bildet ble slettet eller erstattet mens det ble lastet opp – rydd vekk det vi nettopp sendte.
			await store.delete(row.original_key).catch(() => {});
		} else {
			// Ikke la slettekøen fjerne en nøkkel som nå er i bruk.
			run(`DELETE FROM store_deletes WHERE key = ?`, row.original_key);
		}
		await fsp.rm(file, { force: true });
		did = true;
	}
	return did;
}

async function processDeletes(): Promise<boolean> {
	const store = originalStore();
	const rows = all<{ key: string }>(`SELECT key FROM store_deletes ORDER BY attempts, created_at LIMIT 50`);
	let did = false;
	for (const { key } of rows) {
		// Hvis nøkkelen er i bruk igjen (svært usannsynlig), ikke slett.
		if (one(`SELECT 1 FROM photos WHERE original_key = ?`, key)) {
			run(`DELETE FROM store_deletes WHERE key = ?`, key);
			continue;
		}
		try {
			await store.delete(key);
			run(`DELETE FROM store_deletes WHERE key = ?`, key);
			did = true;
		} catch (err) {
			run(
				`UPDATE store_deletes SET attempts = attempts + 1, last_error = ? WHERE key = ?`,
				(err as Error).message.slice(0, 500),
				key
			);
			if (err instanceof StoreUnavailableError) {
				state.health = { ...state.health, ok: false, checkedAt: now(), error: err.message };
				return did;
			}
		}
	}
	return did;
}

// --- Database-backup ---

async function backupIfDue() {
	const store = backupStore();
	if (!store) return;
	if (!state.lastBackupAt) {
		const row = one<{ value: string }>(`SELECT value FROM settings WHERE key = 'last_backup_at'`);
		state.lastBackupAt = row ? Number(row.value) : 0;
	}
	if (now() - state.lastBackupAt < config.backupIntervalHours * 3600_000) return;
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
	const file = path.join(config.tmpDir, `backup-${stamp}.db`);
	try {
		await fsp.mkdir(config.tmpDir, { recursive: true });
		await fsp.rm(file, { force: true });
		db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
		await store.put(`foto-${stamp}.db`, file, 'application/vnd.sqlite3');
		state.lastBackupAt = now();
		state.lastBackupError = null;
		run(
			`INSERT INTO settings (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			String(state.lastBackupAt)
		);
		const existing = (await store.list('foto-')).filter((o) => o.key.endsWith('.db')).sort((a, b) => (a.key < b.key ? 1 : -1));
		for (const old of existing.slice(config.backupKeep)) await store.delete(old.key).catch(() => {});
	} catch (err) {
		state.lastBackupError = (err as Error).message;
		console.error('[foto] backup feilet:', err);
	} finally {
		await fsp.rm(file, { force: true }).catch(() => {});
	}
}

async function cleanTmp() {
	// Rester etter avbrutte opplastinger.
	try {
		for (const name of await fsp.readdir(config.tmpDir)) {
			const p = path.join(config.tmpDir, name);
			const s = await fsp.stat(p);
			if (now() - s.mtimeMs > 6 * 3600_000) await fsp.rm(p, { recursive: true, force: true });
		}
	} catch {
		// mappa finnes kanskje ikke ennå
	}
}

export function startWorker() {
	if (state.started) return;
	state.started = true;
	void checkHealth().then(() => kickWorker());
	setInterval(() => void checkHealth().then(() => kickWorker()), 60_000).unref();
	setInterval(() => kickWorker(), 20_000).unref();
	setInterval(() => void backupIfDue(), 15 * 60_000).unref();
	setTimeout(() => void backupIfDue(), 30_000).unref();
	setInterval(() => void cleanTmp(), 3600_000).unref();
}
