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
	`,
	// 2: gjester – grupper (familie/kunde), medlemmer, tilgang til mapper/album og innloggingslenker.
	`
	CREATE TABLE groups (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'family' CHECK (kind IN ('family', 'client')),
		created_at INTEGER NOT NULL
	);
	CREATE TABLE group_members (
		group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (group_id, user_id)
	);
	CREATE INDEX group_members_user ON group_members (user_id);
	CREATE TABLE node_access (
		node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (node_id, group_id)
	);
	CREATE INDEX node_access_group ON node_access (group_id);
	CREATE TABLE login_tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		purpose TEXT NOT NULL CHECK (purpose IN ('login', 'invite')),
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX login_tokens_user ON login_tokens (user_id);
	ALTER TABLE users ADD COLUMN last_login_at INTEGER;
	`,
	// 3: utløpsdato og nedlasting per gruppe, favoritter (kunden velger bilder).
	`
	ALTER TABLE groups ADD COLUMN expires_at INTEGER;
	ALTER TABLE groups ADD COLUMN download TEXT NOT NULL DEFAULT 'album' CHECK (download IN ('album', 'yes', 'no'));
	CREATE TABLE favorites (
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, photo_id)
	);
	CREATE INDEX favorites_photo ON favorites (photo_id);
	CREATE TABLE favorite_submissions (
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		album_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		count INTEGER NOT NULL,
		submitted_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, album_id)
	);
	`,
	// 4: «velg N bilder», låst valg, påminnelse før tilgangen går ut, statistikk per mappe/album.
	`
	ALTER TABLE nodes ADD COLUMN pick_count INTEGER;
	ALTER TABLE favorite_submissions ADD COLUMN locked_at INTEGER;
	ALTER TABLE groups ADD COLUMN reminded_at INTEGER;
	CREATE TABLE node_stats (
		node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		day TEXT NOT NULL,
		views INTEGER NOT NULL DEFAULT 0,
		downloads INTEGER NOT NULL DEFAULT 0,
		zips INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (node_id, day)
	);
	CREATE INDEX node_stats_day ON node_stats (day);
	CREATE TABLE guest_activity (
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		views INTEGER NOT NULL DEFAULT 0,
		downloads INTEGER NOT NULL DEFAULT 0,
		zips INTEGER NOT NULL DEFAULT 0,
		first_at INTEGER NOT NULL,
		last_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, node_id)
	);
	CREATE INDEX guest_activity_node ON guest_activity (node_id);
	`,
	// 5: video (avspillingsversjon lages i bakgrunnen), opplasting i biter for store filer,
	//    og kategorier som deler innholdet i en mappe inn i grupper (f.eks. båter etter rederi).
	`
	ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo';
	ALTER TABLE photos ADD COLUMN duration REAL;
	ALTER TABLE photos ADD COLUMN video TEXT;
	ALTER TABLE photos ADD COLUMN video_state TEXT;
	ALTER TABLE photos ADD COLUMN video_error TEXT;
	ALTER TABLE photos ADD COLUMN video_attempts INTEGER NOT NULL DEFAULT 0;
	CREATE INDEX photos_video_pending ON photos (video_state) WHERE video_state = 'pending';
	CREATE TABLE uploads (
		id TEXT PRIMARY KEY,
		album_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		replace_id TEXT,
		filename TEXT NOT NULL,
		size INTEGER NOT NULL,
		received INTEGER NOT NULL DEFAULT 0,
		meta TEXT NOT NULL DEFAULT '{}',
		photo_id TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE categories (
		id TEXT PRIMARY KEY,
		parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		color TEXT,
		sort_index INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX categories_parent ON categories (ifnull(parent_id, ''), sort_index);
	ALTER TABLE nodes ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
	ALTER TABLE nodes ADD COLUMN category_style TEXT;
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
