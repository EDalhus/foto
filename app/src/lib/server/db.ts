import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { config } from './config';

/**
 * Skjema. Nye endringer legges til som nye elementer i MIGRATIONS – aldri endre en
 * migrering som allerede er kjørt. `PRAGMA user_version` holder styr på hvor langt vi er.
 */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		name TEXT NOT NULL DEFAULT '',
		role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
		password_hash TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE api_tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		prefix TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	);
	CREATE TABLE nodes (
		id TEXT PRIMARY KEY,
		parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
		type TEXT NOT NULL CHECK (type IN ('folder', 'album')),
		name TEXT NOT NULL,
		slug TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
		allow_download INTEGER NOT NULL DEFAULT 0,
		cover_photo_id TEXT,
		sort_index INTEGER NOT NULL DEFAULT 0,
		lr_ref TEXT UNIQUE,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE UNIQUE INDEX nodes_parent_slug ON nodes (ifnull(parent_id, ''), slug);
	CREATE TABLE photos (
		id TEXT PRIMARY KEY,
		album_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		sort_index INTEGER NOT NULL DEFAULT 0,
		version INTEGER NOT NULL DEFAULT 1,
		filename TEXT NOT NULL,
		mime TEXT NOT NULL,
		bytes INTEGER NOT NULL,
		sha256 TEXT NOT NULL,
		width INTEGER NOT NULL,
		height INTEGER NOT NULL,
		title TEXT NOT NULL DEFAULT '',
		caption TEXT NOT NULL DEFAULT '',
		keywords TEXT NOT NULL DEFAULT '[]',
		taken_at INTEGER,
		exif TEXT NOT NULL DEFAULT '{}',
		color TEXT,
		sizes TEXT NOT NULL DEFAULT '[]',
		original_key TEXT NOT NULL,
		original_state TEXT NOT NULL DEFAULT 'pending' CHECK (original_state IN ('pending', 'stored')),
		original_error TEXT,
		original_attempts INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX photos_album ON photos (album_id, sort_index);
	CREATE INDEX photos_pending ON photos (original_state) WHERE original_state = 'pending';
	CREATE TABLE store_deletes (
		key TEXT PRIMARY KEY,
		attempts INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`
];

function open(): DatabaseSync {
	fs.mkdirSync(config.dataDir, { recursive: true });
	const db = new DatabaseSync(config.dbPath);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
	for (let v = current; v < MIGRATIONS.length; v++) {
		db.exec('BEGIN');
		try {
			db.exec(MIGRATIONS[v]);
			db.exec(`PRAGMA user_version = ${v + 1}`);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}
	return db;
}

const globalKey = Symbol.for('foto.db');
type G = typeof globalThis & { [globalKey]?: DatabaseSync };

/** Én delt tilkobling (overlever hot reload i dev). */
export const db: DatabaseSync = ((globalThis as G)[globalKey] ??= open());

/** Kjør `fn` i en transaksjon. Nestede kall gjenbruker den ytre transaksjonen. */
let depth = 0;
export function tx<T>(fn: () => T): T {
	if (depth > 0) return fn();
	depth++;
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		depth--;
	}
}

export function one<T>(sql: string, ...params: unknown[]): T | undefined {
	return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
	return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(sql: string, ...params: unknown[]) {
	return db.prepare(sql).run(...(params as never[]));
}
