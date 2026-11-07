// One user: make or unmake them an admin, or remove them. Admins only.
import type { Env } from '../../lib/gate.ts';
import { body, pathEmail, reply } from '../../lib/http.ts';
import { removeUser, setAdmin } from '../../lib/users.ts';
import type { Data } from '../../_middleware.ts';

export const onRequestPatch: PagesFunction<Env, 'email', Data> = async ({ data, request, params }) =>
	reply(await setAdmin(data.store, data.user, pathEmail(params), (await body(request)).admin, new Date()));

export const onRequestDelete: PagesFunction<Env, 'email', Data> = async ({ data, params }) =>
	reply(await removeUser(data.store, data.user, pathEmail(params), new Date()));
