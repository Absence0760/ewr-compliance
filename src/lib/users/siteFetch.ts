// The app's own fetches for files of the site (data/, geo/, dws/). On the hosted site every one of them
// needs the 15-minute CloudFront cookies, and the edge answers a request without live ones with 401 JSON
// when it carries X-Requested-With (infra/edge_functions.tf), or with a redirect to the sign-in page when
// it does not, which a fetch would follow and then try to read a page as data. So each sends the header,
// and a 401 goes to the session (session.svelte.ts): one refresh of the cookies and one more try, or the
// sign-in page. Never for another origin (the ArcGIS layers): the header is the site's, and would make
// their requests preflighted.
//
// No DOM and no $app import, so it is tested in node (siteFetch.test.ts).

/** Sent on every call to the site's own API and files. */
export const XHR = { 'X-Requested-With': 'XMLHttpRequest' } as const;

/** The site said the sign-in is over (401). */
export class SignedOut extends Error {
	constructor() {
		super('Your sign-in has ended. Sign in again to go on.');
		this.name = 'SignedOut';
	}
}

/** What a file's 401 does: true when the cookies were renewed and the fetch may be tried again. */
type Unauthorized = () => Promise<boolean>;

let onUnauthorized: Unauthorized = () => Promise.resolve(false);
let onRefused: () => void = () => {};

/**
 * The session's hooks: `unauthorized` for the first 401, `refused` when the fetch is still refused after
 * the cookies were renewed, which the session takes as signed out.
 */
export function whenUnauthorized(unauthorized: Unauthorized, refused: () => void) {
	onUnauthorized = unauthorized;
	onRefused = refused;
}

function withXhr(headers: HeadersInit | undefined): Headers {
	const h = new Headers(headers);
	for (const [k, v] of Object.entries(XHR)) h.set(k, v);
	return h;
}

/**
 * fetch() for a file of this site, by a same-origin path or URL. Answers as fetch does, apart from a 401,
 * which throws SignedOut once the session has had its one chance to renew the cookies.
 */
export async function siteFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const go = () => fetch(input, { ...init, credentials: 'same-origin', headers: withXhr(init.headers) });
	const res = await go();
	if (res.status !== 401) return res;
	if (await onUnauthorized()) {
		const again = await go();
		if (again.status !== 401) return again;
		onRefused();
	}
	throw new SignedOut();
}
