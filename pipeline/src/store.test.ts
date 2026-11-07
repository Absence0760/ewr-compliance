import { describe, expect, it } from 'vitest';
import { handler } from './handler.ts';
import { S3Store } from './store.ts';

/** An S3 client stub: answers each command by its class name, recording the input. */
function stubS3(answer: (name: string, input: Record<string, unknown>) => unknown) {
	const sent: { name: string; input: Record<string, unknown> }[] = [];
	return {
		sent,
		client: {
			async send(command: unknown) {
				const c = command as { constructor: { name: string }; input: Record<string, unknown> };
				sent.push({ name: c.constructor.name, input: c.input });
				const r = answer(c.constructor.name, c.input);
				if (r instanceof Error) throw r;
				return r;
			}
		}
	};
}

const s3Error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('S3Store', () => {
	it('reads an object and its ETag, and a missing key as null', async () => {
		const s3 = stubS3((_, input) => (input.Key === 'a' ? { Body: { transformToString: async () => 'body' }, ETag: '"e"' } : s3Error('NoSuchKey', 404)));
		const store = new S3Store('bucket', s3.client);
		await expect(store.get('a')).resolves.toEqual({ body: 'body', etag: '"e"' });
		await expect(store.get('b')).resolves.toBeNull();
		expect(s3.sent[0]).toMatchObject({ name: 'GetObjectCommand', input: { Bucket: 'bucket', Key: 'a' } });
	});

	it('sends a conditional put, and reads a lost condition as false', async () => {
		const s3 = stubS3((_, input) => (input.IfNoneMatch ? s3Error('PreconditionFailed', 412) : {}));
		const store = new S3Store('bucket', s3.client);
		await expect(store.put('k', 'x', { contentType: 'application/json', ifNoneMatch: '*' })).resolves.toBe(false);
		await expect(store.put('k', 'x', { contentType: 'application/json', cacheControl: 'private, no-cache' })).resolves.toBe(true);
		expect(s3.sent[1]?.input).toEqual({ Bucket: 'bucket', Key: 'k', Body: 'x', ContentType: 'application/json', CacheControl: 'private, no-cache' });
	});

	it('throws a failed put that had no condition to lose', async () => {
		const store = new S3Store('bucket', stubS3(() => s3Error('PreconditionFailed', 412)).client);
		await expect(store.put('k', 'x', { contentType: 'application/json' })).rejects.toThrow('PreconditionFailed');
	});

	it('deletes only on a matching ETag', async () => {
		const s3 = stubS3((_, input) => (input.IfMatch === '"old"' ? s3Error('PreconditionFailed', 412) : {}));
		const store = new S3Store('bucket', s3.client);
		await expect(store.deleteIf('lease/dws.json', '"old"')).resolves.toBe(false);
		await expect(store.deleteIf('lease/dws.json', '"mine"')).resolves.toBe(true);
		expect(s3.sent[1]).toMatchObject({ name: 'DeleteObjectCommand', input: { Key: 'lease/dws.json', IfMatch: '"mine"' } });
	});

	it('tells a missing key from a refused one', async () => {
		const s3 = stubS3((_, input) => (input.Key === 'gone' ? s3Error('NotFound', 404) : s3Error('AccessDenied', 403)));
		const store = new S3Store('bucket', s3.client);
		await expect(store.exists('gone')).resolves.toBe(false);
		await expect(store.exists('denied')).rejects.toThrow('AccessDenied');
	});
});

describe('handler', () => {
	const context = { getRemainingTimeInMillis: () => 900_000 };

	it('needs its bucket', async () => {
		delete process.env.DWS_BUCKET;
		await expect(handler({ mode: 'daily' }, context)).rejects.toThrow('DWS_BUCKET');
	});

	it('refuses an unknown event, and a backfill window that is not one', async () => {
		process.env.DWS_BUCKET = 'ewr-compliance-dws-000000000000';
		await expect(handler({ mode: 'everything' }, context)).rejects.toThrow('Unknown event');
		await expect(handler({ mode: 'backfill', from: '2010-01-01' }, context)).rejects.toMatchObject({ name: 'StoreFormatError' });
		delete process.env.DWS_BUCKET;
	});
});
