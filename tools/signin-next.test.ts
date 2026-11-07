// The sign-in page's redirect after signing in (static/signin/next.js): only ever a path on this site.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain JavaScript served as is, without types
import { safeNext } from '../static/signin/next.js';

const ORIGIN = 'https://ewr.example.test';
const next = (raw: string | null, here = '/signin/') => safeNext(raw, ORIGIN, here) as string;

describe('the sign-in redirect', () => {
	it('keeps a path on this site, with its query and fragment', () => {
		expect(next('/nodes/')).toBe('/nodes/');
		expect(next('/wma/breede-olifants/?node=x#top')).toBe('/wma/breede-olifants/?node=x#top');
		expect(next('/data/index.json')).toBe('/data/index.json');
	});

	it('goes home for anything that could leave the site', () => {
		for (const raw of [
			'https://evil.example/',
			'//evil.example/',
			'///evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'javascript:alert(1)',
			'data:text/html,x',
			'nodes/',
			'',
			'/a/..//evil.example',
			'/%2e%2e//evil.example',
			'/\tevil',
			'/\n/evil.example',
			' /nodes/'
		]) {
			expect(next(raw), JSON.stringify(raw)).toBe('/');
			expect(new URL(next(raw), ORIGIN).origin).toBe(ORIGIN);
		}
	});

	it('never goes back to sign-in or to the API', () => {
		for (const raw of ['/signin/', '/signin', '/signin/?next=/x', '/api/auth/logout', '/api/me']) expect(next(raw)).toBe('/');
	});

	it('uses the address it was served at when CloudFront showed it for a 403', () => {
		expect(next(null, '/nodes/?x=1')).toBe('/nodes/?x=1');
		expect(next(null, '/signin/')).toBe('/');
		expect(next(null, '//evil.example/')).toBe('/');
	});
});
