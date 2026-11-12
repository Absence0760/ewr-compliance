// The API's routes, over auth-kit. lambda.ts builds the dependencies and translates Lambda's event;
// everything that decides anything is here, and app.test.ts runs it against auth-kit's memory
// store.
//
//   POST   /api/auth/code               ask for a code: 202 whatever the address (padded in time)
//   POST   /api/auth/verify             a code: the session cookie and the file cookies
//   POST   /api/auth/refresh            re-checks the session and the list, then new file cookies
//   POST   /api/auth/logout             this session ends; the cookies are cleared
//   POST   /api/auth/logout-everywhere  every session of this user ends
//   GET    /api/me                      who is signed in
//   GET    /api/users                   the list (admins)
//   POST   /api/users                   add someone (admins)
//   PATCH  /api/users/:id               make or unmake an admin (admins)
//   DELETE /api/users/:id               remove someone (admins)
//   GET    /api/audit?limit=n           the audit rows, newest first (admins)
//   POST   /api/nodes                   write one node of the node store: { wma, node, texts } (admins)
//   POST   /api/nodes/delete            delete one: { wma, id }; a built-in node is hidden (admins)
//   POST   /api/nodes/restore           restore a hidden built-in node: { wma, id } (admins)
//   The /api/nodes routes are there only with the node store (NODES_BUCKET, nodes.ts); each body is
//   checked against src/lib/ewr/nodeStore.ts, and each change is an audit row (app.node.<op>) written
//   before it is, so no change goes unrecorded (nodes.ts says when).
//
// Rules every route keeps:
//   - CloudFront stamps X-Origin-Secret on every /api/* request; without it the answer is a bare
//     404, so a direct call to the Function URL (public by AWS design) gets nothing.
//   - "Not signed in" is 401 JSON, never 403: the distribution swaps any 403 for the sign-in page
//     (infra/site.tf). Nothing here answers 403 at all: auth-kit's "only an admin" (403) goes out
//     as 404, which also says nothing to a non-admin about what exists.
//   - Every session is re-read from the table on every call (auth-kit verifySession), so a
//     removed user gets 401 at once. Their file cookies last at most FILE_ACCESS_SECONDS more.
//   - A write (anything but GET) must carry Origin: https://<domain>, and a body must be JSON
//     (415 otherwise). With SameSite=Strict cookies this is belt and braces against CSRF.
//   - Logs carry an event name and an opaque id (a user's UUID, or for an address that may not
//     be listed, a prefix of auth-kit's address HMAC). Never an address, a code or a token.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	CODE_TTL_MS,
	DEFAULT_MIN_LATENCY_MS,
	SESSION_TTL_SECONDS,
	clearSessionCookie,
	normalEmail,
	readCookie,
	sessionCookie,
	withMinimumLatency,
	type AuthKit,
	type AuditEntry,
	type Clock,
	type Result,
	type Session,
	type Sleep,
	type UserRecord
} from '@absence0760/auth-kit';
import { FILE_ACCESS_SECONDS, clearSignedCookies, signedCookies, type Signer } from './cloudfront.ts';
import { error, json, unauthorized, type ApiRequest, type ApiResponse } from './http.ts';
import { codeEmail, type SendMail } from './mail.ts';
import { MAX_NODE_BODY_BYTES, auditTarget, checkPut, checkTarget, type NodeStore } from './nodes.ts';

/** The session cookie: `__Host-ewr_session` (auth-kit adds the prefix). */
export const SESSION_COOKIE = 'ewr_session';
/** The largest request body read: an address and a code are far smaller. */
export const MAX_BODY_BYTES = 8 * 1024;

export type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

export interface ApiDeps {
	auth: AuthKit;
	domain: string;
	/** The value CloudFront stamps as X-Origin-Secret. */
	originSecret: string;
	/** The CloudFront signing key, loaded once and cached (lambda.ts). Throws when it isn't set up. */
	signer: () => Promise<Signer>;
	sendMail: SendMail;
	log: Log;
	clock?: Clock;
	sleep?: Sleep;
	/** The floor on /api/auth/code and /api/auth/verify. */
	minLatencyMs?: number;
	/** The admin node store, with NODES_BUCKET (lambda.ts). Without it /api/nodes is not found. */
	nodes?: { store: NodeStore; recordAudit: RecordAudit };
}

/** A node-store change, as its audit action is named: `app.node.<op>` in auth-kit's log. */
export type NodeAction = 'node.put' | 'node.delete' | 'node.restore';

/**
 * Writes the audit row for an admin's node-store change, re-checking in the same write that the
 * actor is still an admin: auth-kit's recordAppAction (lambda.ts). Its 403 goes out as 404.
 */
export type RecordAudit = (actor: UserRecord, action: NodeAction, target: string) => Promise<Result<unknown>>;

export interface PublicUser {
	id: string;
	email: string;
	admin: boolean;
	addedBy: string;
	addedAt: string;
}

const publicUser = (u: UserRecord): PublicUser => ({ id: u.id, email: u.email, admin: u.isAdmin, addedBy: u.addedBy, addedAt: u.addedAt });
const me = (u: UserRecord) => ({ id: u.id, email: u.email, admin: u.isAdmin });

/** A shape the router accepts before anything else reads it: lowercase segments of letters, digits and '-'. */
const PATH = /^\/api(\/[a-z0-9-]{1,64}){1,3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Compared as digests, so the time taken says nothing about the length or a matching prefix. */
export const sameSecret = (given: string | undefined, expected: string) => given !== undefined && timingSafeEqual(digest(given), digest(expected));

const NOT_FOUND = () => error(404, 'Not found.');

/** auth-kit's Result as an answer. Its 403 ("only an admin") goes out as 404: see the header. */
function reply<T>(r: Result<T>, map: (v: T) => unknown, status = 200): ApiResponse {
	if (r.ok) return json(status, map(r.value));
	return error(r.status === 403 ? 404 : r.status, r.error);
}

class BadRequest extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function createApi(d: ApiDeps) {
	const origin = `https://${d.domain}`;
	const clock = d.clock ?? { now: () => Date.now() };
	const minLatency = d.minLatencyMs ?? DEFAULT_MIN_LATENCY_MS;
	/**
	 * Pads a sign-in step to the floor. Work that takes longer than the floor shows in the timing, and
	 * could say whether an address is listed (a send is slower than no send), so it is logged as
	 * auth.slow, which has an alarm (infra/auth.tf): raise the floor if it fires.
	 */
	const pad = <T>(route: string, fn: () => Promise<T>) =>
		withMinimumLatency(
			minLatency,
			async () => {
				const start = clock.now();
				try {
					return await fn();
				} finally {
					if (clock.now() - start > minLatency) d.log('auth.slow', { route, ms: clock.now() - start });
				}
			},
			{ clock, ...(d.sleep ? { sleep: d.sleep } : {}) }
		);
	const nowSeconds = () => Math.floor(clock.now() / 1000);

	const clearAll = () => [clearSessionCookie(SESSION_COOKIE), ...clearSignedCookies()];

	async function current(req: ApiRequest): Promise<{ user: UserRecord; session: Session } | null> {
		const token = readCookie(req.cookie, SESSION_COOKIE);
		return token ? d.auth.verifySession(token) : null;
	}

	/** The file cookies, to the earlier of 15 minutes from now and the session's end. */
	function fileCookies(signer: Signer, session: Session): string[] | null {
		const now = nowSeconds();
		const until = Math.min(now + FILE_ACCESS_SECONDS, session.expiresAt);
		return until > now ? signedCookies(d.domain, until, signer, now) : null;
	}

	/** The body as a JSON object. Its size is checked before it is parsed. */
	function body(req: ApiRequest, limit = MAX_BODY_BYTES): Record<string, unknown> {
		const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
		if (type !== 'application/json') throw new BadRequest(415, 'Send JSON (Content-Type: application/json).');
		const text = req.body ?? '';
		if (Buffer.byteLength(text) > limit) throw new BadRequest(413, 'The request is too large.');
		if (text.trim() === '') return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new BadRequest(400, 'The request is not valid JSON.');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest(400, 'Send a JSON object.');
		return parsed as Record<string, unknown>;
	}

	/** Changes must come from the site's own pages. */
	function sameOrigin(req: ApiRequest) {
		const site = req.headers['sec-fetch-site'];
		if (req.headers.origin !== origin || (site !== undefined && site !== 'same-origin')) {
			throw new BadRequest(400, 'A change must be made from this site.');
		}
	}

	// --- Sign-in ---------------------------------------------------------------------------

	async function requestCode(req: ApiRequest): Promise<ApiResponse> {
		const { email } = body(req);
		const r = await pad('code', async () => {
			const r = await d.auth.requestCode(email);
			if (r.status === 'accepted' && r.delivery) {
				// A failed send must look like any other accepted request, or it would say who is listed.
				try {
					await d.sendMail(r.delivery.to, codeEmail(r.delivery.code, d.domain, CODE_TTL_MS / 60_000));
					d.log('auth.code.sent', { user: r.delivery.user.id });
				} catch (e) {
					d.log('auth.code.send_failed', { user: r.delivery.user.id, error: e instanceof Error ? e.name : 'error' });
				}
			}
			return r;
		});
		switch (r.status) {
			case 'accepted':
				return json(202, { accepted: true });
			case 'invalid':
				return error(400, 'Enter a whole email address, such as name@example.com.');
			case 'throttled':
				return tooSoon(r.retryAfterMs, 'Wait a little before asking for another code.');
			case 'locked':
				return tooSoon(r.retryAfterMs, 'Too many wrong codes. Wait before trying again.');
		}
	}

	async function verify(req: ApiRequest): Promise<ApiResponse> {
		const { email, code } = body(req);
		// Before the code is checked, so a missing key can't spend someone's code.
		const signer = await d.signer();
		const v = await pad('verify', () => d.auth.verifyCode(email, code));
		if (v.status === 'ok') {
			const { token, session } = await d.auth.issueSession(v.user);
			const files = fileCookies(signer, session)!;
			d.log('auth.signin', { user: v.user.id });
			return json(200, me(v.user), { cookies: [sessionCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS), ...files] });
		}
		if (v.status === 'locked') {
			if (v.lockStarted) {
				const address = normalEmail(email);
				d.log('auth.locked', { subject: address ? (await d.auth.deps.keys.addressKey(address)).slice(0, 16) : 'unknown' });
			}
			return tooSoon(v.retryAfterMs, 'Too many wrong codes. Wait before trying again.');
		}
		return error(400, 'That code is wrong or has expired. Check it, or ask for a new one.');
	}

	async function refresh(req: ApiRequest): Promise<ApiResponse> {
		const s = await current(req);
		if (!s) return unauthorized(clearAll());
		const files = fileCookies(await d.signer(), s.session);
		if (!files) return unauthorized(clearAll());
		return json(200, me(s.user), { cookies: files });
	}

	async function logout(req: ApiRequest): Promise<ApiResponse> {
		const s = await current(req);
		if (s) {
			await d.auth.signOut(s.session);
			d.log('auth.signout', { user: s.user.id });
		}
		return json(200, { signedOut: true }, { cookies: clearAll() });
	}

	async function logoutEverywhere(user: UserRecord): Promise<ApiResponse> {
		await d.auth.signOutEverywhere(user.id);
		d.log('auth.signout_everywhere', { user: user.id });
		return json(200, { signedOut: true }, { cookies: clearAll() });
	}

	function tooSoon(ms: number, message: string): ApiResponse {
		const seconds = Math.max(1, Math.ceil(ms / 1000));
		return error(429, message, { headers: { 'Retry-After': String(seconds) } });
	}

	// --- Users -----------------------------------------------------------------------------

	async function users(req: ApiRequest, actor: UserRecord, id: string | undefined): Promise<ApiResponse> {
		if (id === undefined) {
			if (req.method === 'GET') return reply(await d.auth.listUsers(actor), (us) => us.map(publicUser));
			if (req.method === 'POST') {
				const b = body(req);
				const r = await d.auth.addUser(actor, b.email, b.admin);
				if (r.ok) d.log('users.add', { user: actor.id, target: r.value.id });
				return reply(r, publicUser, 201);
			}
			return notAllowed('GET, POST');
		}
		if (!UUID.test(id)) return error(404, 'That user is not on the list.');
		if (req.method === 'PATCH') {
			const r = await d.auth.setAdmin(actor, { id }, body(req).admin);
			if (r.ok) d.log('users.set_admin', { user: actor.id, target: id, admin: r.value.isAdmin });
			return reply(r, publicUser);
		}
		if (req.method === 'DELETE') {
			const r = await d.auth.removeUser(actor, { id });
			if (r.ok) d.log('users.remove', { user: actor.id, target: id });
			return reply(r, () => ({ removed: true }));
		}
		return notAllowed('PATCH, DELETE');
	}

	async function audit(req: ApiRequest, actor: UserRecord): Promise<ApiResponse> {
		const raw = req.query.get('limit');
		const limit = raw === null ? undefined : /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
		return reply(await d.auth.listAudit(actor, limit), (rows: AuditEntry[]) => rows.map(({ id, at, actor, action, target, admin }) => ({ id, at, actor, action, target, ...(admin !== undefined ? { admin } : {}) })));
	}

	// --- Node store ------------------------------------------------------------------------

	async function nodes(req: ApiRequest, actor: UserRecord, op: 'put' | 'delete' | 'restore'): Promise<ApiResponse> {
		const n = d.nodes!;
		if (req.method !== 'POST') return notAllowed('POST');
		// As auth-kit's "only an admin": not found, before the body is read.
		if (!actor.isAdmin) return NOT_FOUND();
		const b = body(req, MAX_NODE_BODY_BYTES);
		const checked = op === 'put' ? checkPut(b, new Date(clock.now()).toISOString()) : checkTarget(b);
		if (!checked.ok) return error(checked.status, checked.error);
		const { wma } = checked.value;
		const id = 'node' in checked.value ? checked.value.node.id : checked.value.id;
		// The audit row, written by the store once the change applies and before anything is put (nodes.ts):
		// an admin demoted since the session was read is refused here, and nothing is written.
		const record = async () => {
			const a = await n.recordAudit(actor, `node.${op}`, auditTarget(wma, id));
			return a.ok ? a : { ...a, status: a.status === 403 ? 404 : a.status };
		};
		const r =
			'node' in checked.value
				? await n.store.putNode(wma, checked.value.node, checked.value.texts, record)
				: op === 'delete'
					? await n.store.deleteNode(wma, id, record)
					: await n.store.restoreNode(wma, id, record);
		// The user's id and the WMA only: a node id is the audit row's, not the log's.
		d.log(r.ok ? `nodes.${op}` : 'nodes.refused', { user: actor.id, wma, ...(r.ok ? {} : { op, status: r.status }) });
		return r.ok ? json(200, r.value) : error(r.status, r.error);
	}

	const notAllowed = (allow: string) => error(405, 'Method not allowed.', { headers: { Allow: allow } });

	// --- Router ----------------------------------------------------------------------------

	async function route(req: ApiRequest): Promise<ApiResponse> {
		if (!sameSecret(req.headers['x-origin-secret'], d.originSecret)) {
			d.log('api.origin_secret_rejected', { reason: req.headers['x-origin-secret'] === undefined ? 'missing' : 'mismatch' });
			return NOT_FOUND();
		}
		if (!PATH.test(req.path)) return NOT_FOUND();
		const [, , area, name, id, ...rest] = req.path.split('/');
		if (rest.length) return NOT_FOUND();
		if (req.method !== 'GET') sameOrigin(req);

		if (area === 'auth') {
			if (id !== undefined) return NOT_FOUND();
			const routes: Record<string, (req: ApiRequest) => Promise<ApiResponse>> = {
				code: requestCode,
				verify,
				refresh,
				logout,
				'logout-everywhere': async (r) => {
					const s = await current(r);
					return s ? logoutEverywhere(s.user) : unauthorized(clearAll());
				}
			};
			const handler = name !== undefined ? routes[name] : undefined;
			if (!handler) return NOT_FOUND();
			if (req.method !== 'POST') return notAllowed('POST');
			return handler(req);
		}

		const nodeOp = name === undefined ? 'put' : name === 'delete' || name === 'restore' ? name : null;
		const isNodes = area === 'nodes' && d.nodes !== undefined && id === undefined && nodeOp !== null;
		const known = (area === 'me' && name === undefined) || (area === 'audit' && name === undefined) || (area === 'users' && id === undefined) || isNodes;
		if (!known) return NOT_FOUND();
		const s = await current(req);
		if (!s) return unauthorized();
		if (area === 'me') return req.method === 'GET' ? json(200, me(s.user)) : notAllowed('GET');
		if (area === 'audit') return req.method === 'GET' ? audit(req, s.user) : notAllowed('GET');
		if (isNodes) return nodes(req, s.user, nodeOp!);
		return users(req, s.user, name);
	}

	return async function handle(req: ApiRequest): Promise<ApiResponse> {
		try {
			return await route(req);
		} catch (e) {
			if (e instanceof BadRequest) return error(e.status, e.message);
			if (e instanceof NotReady) {
				d.log('api.not_ready', { reason: e.message });
				return error(503, 'Sign-in is not set up yet. Try again later.');
			}
			// The name only: an SDK error's message can quote a key or an item.
			d.log('api.error', { error: e instanceof Error ? e.name : 'error' });
			return error(500, 'Something went wrong. Try again in a minute.');
		}
	};
}

/** A dependency that isn't there yet (the signing key not put in, a secret unreadable): 503. */
export class NotReady extends Error {
	override name = 'NotReady';
}
