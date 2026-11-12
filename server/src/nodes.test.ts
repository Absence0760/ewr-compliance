// The node store's bucket and its conditional writes. The routes over it are in app.test.ts.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { ATTEMPTS, MemoryNodeBucket, NODE_CACHE, S3NodeBucket, checkPut, checkTarget, createNodeStore, type S3Like } from './nodes.ts';

const ok = async () => ({ ok: true as const, value: null });

/** An S3 client that records each command's input and answers from a list. */
function stub(answers: ((input: Record<string, unknown>) => unknown)[]): S3Like & { inputs: { name: string; input: Record<string, unknown> }[] } {
	const inputs: { name: string; input: Record<string, unknown> }[] = [];
	return {
		inputs,
		async send(command: unknown) {
			const c = command as { constructor: { name: string }; input: Record<string, unknown> };
			inputs.push({ name: c.constructor.name, input: c.input });
			const answer = answers.shift();
			if (!answer) throw new Error('no answer');
			return answer(c.input);
		}
	};
}

const s3Error = (name: string, status: number) => () => {
	throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
};

describe('S3NodeBucket', () => {
	it('reads a served path from its key under serve/, with its ETag', async () => {
		const s3 = stub([() => ({ Body: { transformToString: async () => '{"a":1}' }, ETag: '"e1"' })]);
		expect(await new S3NodeBucket('b', s3).get('nodes-data/index.json')).toEqual({ body: '{"a":1}', etag: '"e1"' });
		expect(s3.inputs[0]).toMatchObject({ input: { Bucket: 'b', Key: 'serve/nodes-data/index.json' } });
		expect(new GetObjectCommand({ Bucket: 'b', Key: 'k' }).constructor.name).toBe(s3.inputs[0]!.name);
	});

	it('answers null for a missing object, and throws anything else', async () => {
		expect(await new S3NodeBucket('b', stub([s3Error('NoSuchKey', 404)])).get('nodes-data/index.json')).toBeNull();
		await expect(new S3NodeBucket('b', stub([s3Error('AccessDenied', 403)])).get('nodes-data/index.json')).rejects.toThrow('AccessDenied');
	});

	it('writes JSON, private and revalidated, with the condition asked for', async () => {
		const s3 = stub([() => ({}), () => ({}), () => ({})]);
		const bucket = new S3NodeBucket('b', s3);
		expect(await bucket.put('nodes-data/wma-vaal-orange.json', '{}', { ifMatch: '"e1"' })).toBe(true);
		expect(await bucket.put('nodes-data/index.json', '{}', { ifNoneMatch: '*' })).toBe(true);
		expect(await bucket.put('nodes-data/files/vaal-orange/syx1.json', '{}', {})).toBe(true);
		expect(s3.inputs.map((i) => i.name)).toEqual(Array(3).fill(new PutObjectCommand({ Bucket: 'b', Key: 'k' }).constructor.name));
		expect(s3.inputs[0]!.input).toEqual({ Bucket: 'b', Key: 'serve/nodes-data/wma-vaal-orange.json', Body: '{}', ContentType: 'application/json', CacheControl: 'private, no-cache', IfMatch: '"e1"' });
		expect(s3.inputs[1]!.input).toMatchObject({ IfNoneMatch: '*' });
		expect(s3.inputs[1]!.input).not.toHaveProperty('IfMatch');
		expect(s3.inputs[2]!.input).not.toHaveProperty('IfMatch');
		expect(s3.inputs[2]!.input).not.toHaveProperty('IfNoneMatch');
		expect(NODE_CACHE).toBe('private, no-cache');
	});

	it('answers false for a conditional write that lost (412, or 409 for two at once), and throws otherwise', async () => {
		for (const lost of [s3Error('PreconditionFailed', 412), s3Error('ConditionalRequestConflict', 409)]) {
			expect(await new S3NodeBucket('b', stub([lost])).put('nodes-data/index.json', '{}', { ifMatch: '"e"' })).toBe(false);
		}
		// A 412 on an unconditional write is not a lost race.
		await expect(new S3NodeBucket('b', stub([s3Error('PreconditionFailed', 412)])).put('p', '{}', {})).rejects.toThrow();
		await expect(new S3NodeBucket('b', stub([s3Error('AccessDenied', 403)])).put('p', '{}', { ifNoneMatch: '*' })).rejects.toThrow('AccessDenied');
	});
});

describe('checks', () => {
	it('checkTarget refuses an id that is padded, holds an @ or a control character, is too long, or is another WMA’s upload', () => {
		expect(checkTarget({ wma: 'vaal-orange', id: 'Sample:SY1' })).toEqual({ ok: true, value: { wma: 'vaal-orange', id: 'Sample:SY1' } });
		expect(checkTarget({ wma: 'vaal-orange', id: 'x' })).toMatchObject({ ok: true });
		expect(checkTarget({ wma: 'vaal-orange', id: 'x'.repeat(150) })).toMatchObject({ ok: true });
		for (const id of ['', ' x', 'x ', 'a@b', 'a\nb', 'x'.repeat(151), 3, null]) {
			expect(checkTarget({ wma: 'vaal-orange', id }), JSON.stringify(id)).toMatchObject({ ok: false, status: 400 });
		}
		expect(checkTarget({ wma: 'vaal-orange', id: 'breede-olifants:syx1' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/another WMA/) });
		expect(checkTarget({ wma: 'nowhere', id: 'x' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^Say which WMA/) });
	});

	it('checkPut works out hasTab and hasRevised from the files, whatever the request says', () => {
		const node = { id: 'vaal-orange:syx1', label: 'SYX1', basin: 'Sample Basin', files: [{ name: 'syx1C.tab', kind: 'tab' }], hasRevised: true, hasTab: false };
		const r = checkPut({ wma: 'vaal-orange', node, texts: { 'syx1C.tab': 'x' } }, '2026-11-12T09:00:00.000Z');
		expect(r).toMatchObject({ ok: true, value: { node: { hasTab: true, hasRevised: false } } });
	});
});

describe('the store’s conditional writes', () => {
	const node = { id: 'vaal-orange:syx1', label: 'SYX1', basin: 'Sample Basin', files: [], lon: null, lat: null } as never;

	it(`retries a write that lost to another admin, up to ${ATTEMPTS} times, keeping their change`, async () => {
		const bucket = new MemoryNodeBucket();
		const store = createNodeStore(bucket, () => Date.parse('2026-11-12T09:00:00Z'));
		// Another admin hides a node between each of our reads and puts, twice.
		let theirs = 0;
		bucket.beforePut = async (path) => {
			if (path !== 'nodes-data/wma-vaal-orange.json' || theirs >= ATTEMPTS - 1) return;
			theirs++;
			const before = bucket.objects.get(path);
			const o = before ? JSON.parse(before.body) : { version: 1, wma: 'vaal-orange', updatedAt: '2026-11-12T08:00:00.000Z', nodes: [], deleted: [] };
			o.deleted.push(`Sample:T${theirs}`);
			bucket.objects.set(path, { body: JSON.stringify(o), etag: `"theirs-${theirs}"` });
		};
		let records = 0;
		const r = await store.putNode('vaal-orange', node, {}, async () => (records++, { ok: true, value: null }));
		expect(r).toMatchObject({ ok: true, value: { nodes: 1, deleted: 2 } });
		expect(bucket.json('nodes-data/wma-vaal-orange.json')).toMatchObject({ nodes: [{ id: 'vaal-orange:syx1' }], deleted: ['Sample:T1', 'Sample:T2'] });
		// One audit row, however many tries.
		expect(records).toBe(1);
	});

	it(`answers 409 after ${ATTEMPTS} lost writes, with their file intact`, async () => {
		const bucket = new MemoryNodeBucket();
		const store = createNodeStore(bucket, () => 0);
		let n = 0;
		bucket.beforePut = (path) => {
			if (path === 'nodes-data/wma-vaal-orange.json') bucket.objects.set(path, { body: JSON.stringify({ version: 1, wma: 'vaal-orange', updatedAt: '2026-11-12T08:00:00.000Z', nodes: [], deleted: [`Sample:T${++n}`] }), etag: `"t${n}"` });
		};
		expect(await store.deleteNode('vaal-orange', 'Sample:SY1', ok)).toMatchObject({ ok: false, status: 409 });
		expect(n).toBe(ATTEMPTS);
		expect(bucket.json('nodes-data/wma-vaal-orange.json')).toMatchObject({ deleted: [`Sample:T${ATTEMPTS}`] });
		expect(bucket.objects.has('nodes-data/index.json')).toBe(false);
	});

	it('creates a missing file only if it is still missing (If-None-Match), and builds on one that appeared', async () => {
		const bucket = new MemoryNodeBucket();
		const store = createNodeStore(bucket, () => 0);
		let once = false;
		bucket.beforePut = (path) => {
			if (path === 'nodes-data/index.json' && !once) {
				once = true;
				bucket.objects.set(path, { body: JSON.stringify({ version: 1, wmas: { 'breede-olifants': { updatedAt: '2026-11-12T08:00:00.000Z', nodes: 2, deleted: 0 } } }), etag: '"other"' });
			}
		};
		expect(await store.deleteNode('vaal-orange', 'Sample:SY1', ok)).toMatchObject({ ok: true });
		expect(bucket.json('nodes-data/index.json')).toEqual({
			version: 1,
			wmas: { 'breede-olifants': { updatedAt: '2026-11-12T08:00:00.000Z', nodes: 2, deleted: 0 }, 'vaal-orange': { updatedAt: '1970-01-01T00:00:00.000Z', nodes: 0, deleted: 1 } }
		});
	});

	it('says so when the change landed but the index lost every try', async () => {
		const bucket = new MemoryNodeBucket();
		const store = createNodeStore(bucket, () => 0);
		let n = 0;
		bucket.beforePut = (path) => {
			if (path === 'nodes-data/index.json') bucket.objects.set(path, { body: JSON.stringify({ version: 1, wmas: {} }), etag: `"i${++n}"` });
		};
		expect(await store.deleteNode('vaal-orange', 'Sample:SY1', ok)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/was saved/) });
		expect(bucket.json('nodes-data/wma-vaal-orange.json')).toMatchObject({ deleted: ['Sample:SY1'] });
	});

	it('never builds on a stored file that fails the format', async () => {
		const bucket = new MemoryNodeBucket();
		bucket.objects.set('nodes-data/wma-vaal-orange.json', { body: JSON.stringify({ version: 2 }), etag: '"x"' });
		let records = 0;
		await expect(createNodeStore(bucket, () => 0).deleteNode('vaal-orange', 'Sample:SY1', async () => (records++, { ok: true, value: null }))).rejects.toThrow(/format version 2/);
		expect(bucket.writes).toEqual([]);
		expect(records).toBe(0);
	});
});
