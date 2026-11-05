import type { SubmitFunction } from '@sveltejs/kit';
import { toast } from './toasts.svelte';

interface Options {
	/** Tøm skjemaet etter et vellykket svar (standard: nei). */
	reset?: boolean;
	/** Kjøres etter et vellykket svar, med dataene fra handlingen. */
	onsuccess?: (data: Record<string, unknown> | undefined) => void;
	/** Settes til true mens skjemaet sendes (for å slå av knapper). */
	busy?: (on: boolean) => void;
}

/**
 * use:enhance som viser svaret som en melding nederst på skjermen og laster dataene på nytt.
 * Handlingene returnerer { message } ved suksess og fail(status, { error }) ved feil.
 */
export function submit(opts: Options = {}): SubmitFunction {
	return () => {
		opts.busy?.(true);
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					toast(result.error?.message || 'Noe gikk galt. Prøv igjen.', 'error');
					return;
				}
				await update({ reset: opts.reset ?? false });
				if (result.type === 'success') {
					const message = result.data?.message;
					if (typeof message === 'string' && message) toast(message);
					opts.onsuccess?.(result.data);
				} else if (result.type === 'failure') {
					toast(String(result.data?.error ?? 'Noe gikk galt.'), 'error');
				}
			} finally {
				opts.busy?.(false);
			}
		};
	};
}
