// What the app keeps in localStorage, read safely. Pure: the caller does the reading and writing.
import type { EcBasis, NodeChoices } from '#lib/ewr/types.ts';

export const STORAGE = 'ewr';

/** What is kept across reloads: the EC basis and each node's choices. */
export interface Stored {
	ecBasis?: EcBasis;
	choices?: Record<string, NodeChoices>;
}

/**
 * Keys an older version kept and this one does not. histApi and rtApi held DWS API addresses typed into
 * the Data source, from before the browser stopped calling DWS and read the DWS store instead.
 */
export const RETIRED_KEYS = ['histApi', 'rtApi'] as const;

const EC_BASES: readonly EcBasis[] = ['TEC', 'REC', 'PES'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The stored text, read. Anything unreadable is left out rather than trusted. migrated is true when the
 * text held anything this version does not keep, so the caller writes it back without.
 */
export function readStored(raw: string | null): { stored: Stored; migrated: boolean } {
	let s: unknown;
	try {
		s = JSON.parse(raw || '{}');
	} catch {
		return { stored: {}, migrated: raw !== null };
	}
	if (!isObject(s)) return { stored: {}, migrated: true };
	const stored: Stored = {};
	if (EC_BASES.includes(s.ecBasis as EcBasis)) stored.ecBasis = s.ecBasis as EcBasis;
	if (isObject(s.choices)) stored.choices = s.choices as Record<string, NodeChoices>;
	return { stored, migrated: RETIRED_KEYS.some((k) => k in s) };
}

export const writeStored = (stored: Stored) => JSON.stringify(stored);
