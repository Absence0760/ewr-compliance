// Where to go after signing in: the `next` the edge function or the app sent, or, when CloudFront
// served this page for a 403 at another address, that address. Only a path on this site: anything
// that could leave it (another origin, //host, a backslash, a control character, a path that
// normalises to //host) becomes '/'. Never back to sign-in or the API.

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * @param {string | null} raw the `next` query parameter, decoded
 * @param {string} origin this page's origin
 * @param {string} here this page's own path and query, used when there is no `next`
 * @returns {string} a path, query and fragment on this origin
 */
export function safeNext(raw, origin, here) {
	const candidate = raw ?? (here.startsWith('/signin') ? '/' : here);
	if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
	if (candidate.includes('\\') || CONTROL.test(candidate)) return '/';
	let url;
	try {
		url = new URL(candidate, origin);
	} catch {
		return '/';
	}
	if (url.origin !== origin) return '/';
	const path = url.pathname;
	if (path.startsWith('//') || path === '/signin' || path.startsWith('/signin/') || path.startsWith('/api/')) return '/';
	return path + url.search + url.hash;
}
