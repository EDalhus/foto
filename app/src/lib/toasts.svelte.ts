/** Korte meldinger nederst på skjermen («Lagret», feil osv.). Bare i nettleseren. */
export type ToastKind = 'ok' | 'error' | 'info';

export interface Toast {
	id: number;
	text: string;
	kind: ToastKind;
}

let seq = 0;
export const toasts = $state<{ list: Toast[] }>({ list: [] });

export function toast(text: string, kind: ToastKind = 'ok', ms = kind === 'error' ? 8000 : 3500) {
	const id = ++seq;
	toasts.list = [...toasts.list.slice(-3), { id, text, kind }];
	if (ms > 0) setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number) {
	toasts.list = toasts.list.filter((t) => t.id !== id);
}
