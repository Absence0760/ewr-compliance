// The request and response shapes the API works in, apart from Lambda's event, so the routes are
// tested as plain functions (app.test.ts) and lambda.ts only translates.

export interface ApiRequest {
	method: string;
	/** The raw path, as the viewer sent it (never decoded). */
	path: string;
	query: URLSearchParams;
	/** Lowercase names. */
	headers: Record<string, string | undefined>;
	/** The Cookie header, joined; null when there is none. */
	cookie: string | null;
	body: string | null;
}

export interface ApiResponse {
	status: number;
	headers: Record<string, string>;
	/** Set-Cookie values, one each. */
	cookies: string[];
	body: string;
}

/**
 * Every answer: JSON, never stored by CloudFront or the browser, and the API's security headers. The
 * edge sets the same four (infra/edge_functions.tf, site_response), but a CloudFront Function never
 * runs on a 4xx or 5xx from the origin, so the API sends them itself and its refusals carry them too.
 * tools/edge-functions.test.ts checks the two lists match.
 */
export const BASE_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8',
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'Referrer-Policy': 'no-referrer',
	'Strict-Transport-Security': 'max-age=63072000; includeSubDomains'
};

export function json(status: number, value: unknown, extra: { headers?: Record<string, string>; cookies?: string[] } = {}): ApiResponse {
	return {
		status,
		headers: { ...BASE_HEADERS, ...extra.headers },
		cookies: extra.cookies ?? [],
		body: status === 204 ? '' : JSON.stringify(value)
	};
}

export const error = (status: number, message: string, extra: { headers?: Record<string, string>; cookies?: string[] } = {}) =>
	json(status, { error: message }, extra);

/**
 * "Not signed in" is always 401, never 403: the distribution turns every 403 into the sign-in page
 * (infra/site.tf, custom_error_response), and the app needs this JSON to send the person there.
 */
export const SIGNIN_PATH = '/signin/';
export const unauthorized = (cookies: string[] = []) =>
	json(401, { error: 'You are not signed in, or your sign-in has expired.', signin: SIGNIN_PATH }, { cookies });
