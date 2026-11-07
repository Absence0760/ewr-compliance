import { describe, expect, it } from 'vitest';
import { LEASE_MARGIN_MS, takeLease } from './lease.ts';
import { KEYS, MemoryStore } from './store.ts';
import { clock } from './testing.ts';

describe('takeLease', () => {
	it('takes a free lease, until the deadline plus a margin, and lets it go', async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		const take = await takeLease(store, { holder: 'daily', remainingMs: 900_000, now: t.now });
		if (!('held' in take)) throw new Error('not held');
		const body = store.json(KEYS.lease) as { owner: string; holder: string; expires: number };
		expect(body).toEqual({ owner: take.held.owner, holder: 'daily', expires: (t.now() + 900_000 + LEASE_MARGIN_MS) / 1000 });
		await take.held.release();
		expect(store.objects.has(KEYS.lease)).toBe(false);
	});

	it('is busy while another run holds it, saying who and until when', async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		const first = await takeLease(store, { holder: 'backfill', remainingMs: 900_000, now: t.now });
		expect('held' in first).toBe(true);
		const second = await takeLease(store, { holder: 'daily', remainingMs: 900_000, now: t.now });
		expect(second).toEqual({ busy: { holder: 'backfill', until: new Date(t.now() + 960_000).toISOString() } });
	});

	it('takes over a lease whose holder died, once it has expired', async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		await takeLease(store, { holder: 'backfill', remainingMs: 900_000, now: t.now });
		t.advance(960_001);
		const take = await takeLease(store, { holder: 'daily', remainingMs: 900_000, now: t.now });
		expect('held' in take).toBe(true);
		expect((store.json(KEYS.lease) as { holder: string }).holder).toBe('daily');
	});

	it('lets one of two runs meeting the same expired lease win, never both', async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		await takeLease(store, { holder: 'backfill', remainingMs: 0, now: t.now });
		t.advance(LEASE_MARGIN_MS + 1);
		const takes = await Promise.all([takeLease(store, { holder: 'daily', remainingMs: 900_000, now: t.now }), takeLease(store, { holder: 'backfill', remainingMs: 900_000, now: t.now })]);
		expect(takes.filter((x) => 'held' in x)).toHaveLength(1);
	});

	it("never releases a lease that is no longer its own", async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		const old = await takeLease(store, { holder: 'backfill', remainingMs: 0, now: t.now });
		t.advance(LEASE_MARGIN_MS + 1);
		const now = await takeLease(store, { holder: 'daily', remainingMs: 900_000, now: t.now });
		if (!('held' in old) || !('held' in now)) throw new Error('not held');
		await old.held.release();
		expect((store.json(KEYS.lease) as { owner: string }).owner).toBe(now.held.owner);
	});

	it('takes a torn lease body for no holder', async () => {
		const store = new MemoryStore();
		const t = clock('2026-01-01T00:00:00Z');
		await store.put(KEYS.lease, '{"own', { contentType: 'application/json' });
		expect('held' in (await takeLease(store, { holder: 'daily', remainingMs: 1000, now: t.now }))).toBe(true);
	});
});
