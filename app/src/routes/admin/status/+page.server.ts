import { all, one } from '$lib/server/db';
import { pendingCount } from '$lib/server/photos';
import { backupStatus, checkHealth, storeHealth } from '$lib/server/worker';
import { config } from '$lib/server/config';
import { ffmpegVersion } from '$lib/server/video';
import { videoBusy } from '$lib/server/worker';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	let health = storeHealth();
	if (!health.checkedAt) health = await checkHealth();
	const totals = one<{ photos: number; bytes: number }>(`SELECT count(*) AS photos, coalesce(sum(bytes), 0) AS bytes FROM photos`)!;
	return {
		health,
		pending: pendingCount(),
		deleteQueue: one<{ n: number }>(`SELECT count(*) AS n FROM store_deletes`)?.n ?? 0,
		errors: all<{ id: string; filename: string; original_error: string; original_attempts: number }>(
			`SELECT id, filename, original_error, original_attempts FROM photos WHERE original_error IS NOT NULL ORDER BY updated_at DESC LIMIT 20`
		),
		totals,
		albums: one<{ n: number }>(`SELECT count(*) AS n FROM nodes WHERE type = 'album'`)?.n ?? 0,
		backup: { ...backupStatus(), enabled: !!config.storage.backupBucket },
		video: {
			ffmpeg: await ffmpegVersion(),
			busy: !!videoBusy(),
			pending: one<{ n: number }>(`SELECT count(*) AS n FROM photos WHERE video_state = 'pending'`)?.n ?? 0,
			failed: one<{ n: number }>(`SELECT count(*) AS n FROM photos WHERE video_state = 'failed'`)?.n ?? 0,
			total: one<{ n: number }>(`SELECT count(*) AS n FROM photos WHERE kind = 'video'`)?.n ?? 0
		}
	};
};

export const actions: Actions = {
	check: async () => {
		await checkHealth();
		return {};
	}
};
