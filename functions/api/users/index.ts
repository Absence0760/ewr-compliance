// The user list: read it, or add to it. Admins only.
import type { Env } from '../../lib/gate.ts';
import { body, reply } from '../../lib/http.ts';
import { addUser, listUsers } from '../../lib/users.ts';
import type { Data } from '../../_middleware.ts';

export const onRequestGet: PagesFunction<Env, string, Data> = async ({ data }) => reply(await listUsers(data.store, data.user));

export const onRequestPost: PagesFunction<Env, string, Data> = async ({ data, request }) => {
	const b = await body(request);
	return reply(await addUser(data.store, data.user, b.email, b.admin, new Date()), 201);
};
