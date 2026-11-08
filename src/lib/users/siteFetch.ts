// The app's own fetches for files of the site (data/, geo/, dws/). On the hosted site every one of them
// needs the 15-minute CloudFront cookies. CloudFront checks them before the edge function runs, so a request
// without live ones gets CloudFront's 403, with the sign-in page as its body (infra/site.tf, seen on the
// first deploy). A 403 from the site always means that: a missing file is a 404, in the store too
// (infra/dws.tf). The edge's own 401 JSON (infra/edge_functions.tf, for a request with X-Requested-With) is
// answered the same way, should CloudFront ever let such a request reach it. Either goes to the session
// (session.svelte.ts): one refresh of the cookies and one more try, or the sign-in page. The header is
// never sent to another origin (the ArcGIS layers): it is the site's, and would make their requests
// preflighted.
//
// No DOM and no $app import, so it is tested in node (siteFetch.test.ts).

/** Sent on every call to the site's own API and files. */
export const XHR = { 'X-Requested-With': 'XMLHttpRequest' } as const;

/** The site said the sign-in is over (401 or 403). */
export class SignedOut extends Error {
	constructor() {
		super('Your sign-in has ended. Sign in again to go on.');
		this.name = 'SignedOut';
	}
}

/** What a file's refusal does: true when the cookies were renewed and the fetch may be tried again. */
type Unauthorized = () => Promise<boolean>;

let onUnauthorized: Unauthorized = () => Promise.resolve(false);
let onRefused: () => void = () => {};

/**
 * The session's hooks: `unauthorized` for the first refusal, `refused` when the fetch is still refused after
 * the cookies were renewed, which the session takes as signed out.
 */
export function whenUnauthorized(unauthorized: Unauthorized, refused: () => void) {
	onUnauthorized = unauthorized;
	onRefused = refused;
}

/** Not signed in, as the site says it: CloudFront's 403 for lapsed cookies, or the edge's 401. */
const isRefused = (res: Response) => res.status === 401 || res.status === 403;

function withXhr(headers: HeadersInit | undefined): Headers {
	const h = new Headers(headers);
	for (const [k, v] of Object.entries(XHR)) h.set(k, v);
	return h;
}

/**
 * fetch() for a file of this site, by a same-origin path or URL. Answers as fetch does, apart from a 401 or
 * 403, which throws SignedOut once the session has had its one chance to renew the cookies.
 */
export async function siteFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const go = () => fetch(input, { ...init, credentials: 'same-origin', headers: withXhr(init.headers) });
	const res = await go();
	if (!isRefused(res)) return res;
	if (await onUnauthorized()) {
		const again = await go();
		if (!isRefused(again)) return again;
		onRefused();
	}
	throw new SignedOut();
}
