import { error } from '@sveltejs/kit';
import { WMAS, wmaBySlug } from '#lib/components/map/wma.ts';
import type { EntryGenerator, PageLoad } from './$types';

// One page per WMA, each built as wma/<slug>/index.html.
export const entries: EntryGenerator = () => WMAS.map((w) => ({ wma: w.slug }));

export const load: PageLoad = ({ params }) => {
	const wma = wmaBySlug(params.wma);
	if (!wma) error(404, `No Water Management Area called ${params.wma}`);
	return { wma };
};
