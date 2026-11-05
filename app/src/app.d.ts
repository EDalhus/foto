import type { SessionUser } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			user: SessionUser | null;
			authVia: 'session' | 'token' | null;
		}
		interface PageState {
			/** Bildet som er åpent i visningen (grunn ruting). */
			photoId?: string;
			/** Satt når en egen bildelenke lukkes: albumet ruller til bildet og zoomer det på plass. */
			landing?: {
				id: string;
				rect: { left: number; top: number; width: number; height: number } | null;
				src: string | null;
				color: string | null;
				at: number;
			};
		}
	}
}

export {};
