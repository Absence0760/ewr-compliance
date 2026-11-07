// The one run allowed to ask DWS, and to write the store, at a time: a lease object, lease/dws.json,
// taken by S3 conditional writes, as project-water-management's host slot (backend/src/feeds/hostSlot.ts):
//
//   - created with If-None-Match: *, holding an owner token, the holder ("daily", or "backfill") and an
//     expiry in epoch seconds;
//   - an expired one (a run that died holding it) taken over with If-Match on its ETag, so two takers
//     can't both win;
//   - released at the end by its owner: read, compare the owner, delete with If-Match on that ETag, so a
//     release can never delete a lease someone else has since taken.
//
// The expiry is the holder's own deadline (the Lambda's time left) plus LEASE_MARGIN_MS, so no renewal
// is needed (a Lambda can't run past its timeout) and a run killed by its timeout frees DWS a minute
// later. Two runs at once would ask DWS twice as often and could each rewrite a station's file from the
// same old copy, losing the other's days; with the lease the second finds it held and does neither.
import { randomUUID } from 'node:crypto';
import { KEYS, type Store } from './store.ts';

/** How long past its holder's deadline a lease lasts. */
export const LEASE_MARGIN_MS = 60_000;

export interface HeldLease {
	readonly owner: string;
	/** Let it go, only if it is still ours. Never throws: a lease left behind expires on its own. */
	release(): Promise<void>;
}

export type LeaseTake = { held: HeldLease } | { busy: { holder: string | null; until: string | null } };

interface Body {
	owner?: unknown;
	holder?: unknown;
	expires?: unknown;
}

function parse(text: string): Body {
	try {
		const v = JSON.parse(text) as unknown;
		return typeof v === 'object' && v !== null ? (v as Body) : {};
	} catch {
		// A torn or foreign body has no holder: it counts as expired.
		return {};
	}
}

const expiresAt = (b: Body) => (typeof b.expires === 'number' && Number.isFinite(b.expires) ? b.expires * 1000 : 0);

export async function takeLease(store: Store, o: { holder: 'daily' | 'backfill'; remainingMs: number; now: () => number }): Promise<LeaseTake> {
	const owner = randomUUID();
	const now = o.now();
	const body = `${JSON.stringify({ owner, holder: o.holder, expires: (now + Math.max(0, o.remainingMs) + LEASE_MARGIN_MS) / 1000 })}\n`;
	const put = (cond: { ifNoneMatch: '*' } | { ifMatch: string }) => store.put(KEYS.lease, body, { contentType: 'application/json', ...cond });
	const held = (): LeaseTake => ({ held: { owner, release: () => release(store, owner) } });

	if (await put({ ifNoneMatch: '*' })) return held();
	const got = await store.get(KEYS.lease);
	// Released between our put and this read: once more from the start.
	if (!got) return (await put({ ifNoneMatch: '*' })) ? held() : { busy: { holder: null, until: null } };
	const b = parse(got.body);
	if (expiresAt(b) > now) {
		return { busy: { holder: typeof b.holder === 'string' ? b.holder.slice(0, 40) : null, until: new Date(expiresAt(b)).toISOString() } };
	}
	// Expired (its holder died): take it over, unless someone else just did.
	return (await put({ ifMatch: got.etag })) ? held() : { busy: { holder: null, until: null } };
}

async function release(store: Store, owner: string): Promise<void> {
	try {
		const got = await store.get(KEYS.lease);
		if (!got || parse(got.body).owner !== owner) return;
		await store.deleteIf(KEYS.lease, got.etag);
	} catch {
		// It expires on its own, LEASE_MARGIN_MS past the holder's deadline.
	}
}
