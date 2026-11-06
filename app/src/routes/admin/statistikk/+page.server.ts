import { accessForAll } from '$lib/server/access';
import { overview, periodOf } from '$lib/server/stats';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const period = periodOf(url.searchParams.get('periode'));
	const o = overview(period);
	const access = accessForAll();
	return {
		period,
		...o,
		top: o.top.map((r) => ({ ...r!, mode: access.get(r!.nodeId)?.mode ?? 'public' }))
	};
};
