import { env } from '$env/dynamic/private';
import path from 'node:path';

const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
	siteTitle: env.SITE_TITLE || 'Foto',
	/** Nettstedets adresse (for lenker i e-post som sendes i bakgrunnen). */
	origin: (env.ORIGIN || '').replace(/\/+$/, ''),
	siteTagline: env.SITE_TAGLINE || '',
	dataDir,
	dbPath: path.join(dataDir, 'foto.db'),
	derivedDir: path.join(dataDir, 'derived'),
	pendingDir: path.join(dataDir, 'pending'),
	tmpDir: path.join(dataDir, 'tmp'),
	admin: {
		email: env.ADMIN_EMAIL || '',
		password: env.ADMIN_PASSWORD || ''
	},
	storage: {
		driver: (env.STORAGE_DRIVER || 'local') as 'local' | 's3',
		localDir: path.resolve(env.STORAGE_LOCAL_DIR || path.join(dataDir, 'store')),
		s3: {
			endpoint: (env.S3_ENDPOINT || '').replace(/\/+$/, ''),
			region: env.S3_REGION || 'us-east-1',
			accessKeyId: env.S3_ACCESS_KEY_ID || '',
			secretAccessKey: env.S3_SECRET_ACCESS_KEY || ''
		},
		bucket: env.S3_BUCKET || 'originaler',
		backupBucket: env.S3_BACKUP_BUCKET || ''
	},
	backupIntervalHours: Number(env.BACKUP_INTERVAL_HOURS || 24),
	backupKeep: Number(env.BACKUP_KEEP || 14),
	/** Største tillatte bilde i byte (og største opplasting i én forespørsel). */
	maxUploadBytes: Number(env.MAX_UPLOAD_MB || 300) * 1024 * 1024,
	/** Største fil som kan lastes opp i biter (video). */
	maxLargeUploadBytes: Number(env.MAX_VIDEO_MB || 20480) * 1024 * 1024
};
