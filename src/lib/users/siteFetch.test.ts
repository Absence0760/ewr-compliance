import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedOut, siteFetch, whenUnauthorized } from './siteFetch.ts';

const reply = (status: number) => new Response(status === 200 ? '{}' : '{"error":"signin_required"}', { status });

describe('siteFetch', () => {
	let answers: number[];
	let fetchMock: ReturnType<typeof vi.fn>;
	let unauthorized: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
	let refused: ReturnType<typeof vi.fn<() => void>>;

	beforeEach(() => {
		answers = [];
		fetchMock = vi.fn(async () => reply(answers.shift() ?? 200));
		vi.stubGlobal('fetch', fetchMock);
		unauthorized = vi.fn<() => Promise<boolean>>(async () => true);
		refused = vi.fn<() => void>();
		whenUnauthorized(unauthorized, refused);
	});
	afterEach(() => vi.unstubAllGlobals());

	const headersOf = (call: number) => new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers);

	it('sends X-Requested-With, so the edge answers a lapsed cookie with 401 JSON, not a redirect', async () => {
		await siteFetch('data/index.json');
		expect(headersOf(0).get('X-Requested-With')).toBe('XMLHttpRequest');
		expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('same-origin');
	});

	it('keeps the caller’s options and headers', async () => {
		await siteFetch('dws/index.json', { cache: 'no-cache', headers: { Accept: 'application/json' } });
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.cache).toBe('no-cache');
		expect(headersOf(0).get('Accept')).toBe('application/json');
		expect(headersOf(0).get('X-Requested-With')).toBe('XMLHttpRequest');
	});

	it('answers any other status as fetch does, without asking the session', async () => {
		for (const status of [404, 429, 500, 502]) {
			answers = [status];
			expect((await siteFetch('dws/index.json')).status).toBe(status);
		}
		expect(unauthorized).not.toHaveBeenCalled();
	});

	// What the hosted site actually answers for lapsed cookies: CloudFront checks them before the edge
	// function runs, so its 403 (the sign-in page as the body) comes first. A missing file is a 404.
	it('on a 403 renews the cookies once and tries again, as for a 401', async () => {
		answers = [403, 200];
		const res = await siteFetch('data/gauges.json');
		expect(res.status).toBe(200);
		expect(unauthorized).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(refused).not.toHaveBeenCalled();
	});

	it('throws SignedOut on a 403 when the session cannot renew the cookies', async () => {
		unauthorized.mockResolvedValue(false);
		answers = [403];
		await expect(siteFetch('dws/index.json')).rejects.toBeInstanceOf(SignedOut);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(refused).not.toHaveBeenCalled();
	});

	it('sends the person to sign in when a 403 outlasts a renewal, whichever refusal came first', async () => {
		answers = [401, 403];
		await expect(siteFetch('data/index.json')).rejects.toBeInstanceOf(SignedOut);
		expect(refused).toHaveBeenCalledTimes(1);
		answers = [403, 401];
		await expect(siteFetch('data/index.json')).rejects.toBeInstanceOf(SignedOut);
		expect(refused).toHaveBeenCalledTimes(2);
	});

	it('on a 401 renews the cookies once and tries again', async () => {
		answers = [401, 200];
		const res = await siteFetch('data/gauges.json');
		expect(res.status).toBe(200);
		expect(unauthorized).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(headersOf(1).get('X-Requested-With')).toBe('XMLHttpRequest');
		expect(refused).not.toHaveBeenCalled();
	});

	it('throws SignedOut, and tries nothing more, when the session cannot renew them', async () => {
		unauthorized.mockResolvedValue(false);
		answers = [401];
		await expect(siteFetch('data/index.json')).rejects.toBeInstanceOf(SignedOut);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(refused).not.toHaveBeenCalled();
	});

	it('sends the person to sign in when the file is still refused after a renewal', async () => {
		answers = [401, 401];
		await expect(siteFetch('data/index.json')).rejects.toBeInstanceOf(SignedOut);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(refused).toHaveBeenCalledTimes(1);
	});
});
