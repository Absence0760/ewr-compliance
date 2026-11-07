// The user list: read it, or add to it, then bring the Access group in step. Admins only.
import { groupConfig, type GroupEnv } from '../../lib/accessGroup.ts';
import type { Env } from '../../lib/gate.ts';
import { body, reply } from '../../lib/http.ts';
import { addMember, cloudflareAccess } from '../../lib/membership.ts';
import { listUsers } from '../../lib/users.ts';
import type { Data } from '../../_middleware.ts';

export const onRequestGet: PagesFunction<Env, string, Data> = async ({ data }) => reply(await listUsers(data.store, data.user));

export const onRequestPost: PagesFunction<Env & GroupEnv, string, Data> = async ({ data, request, env }) => {
	const b = await body(request);
	return reply(await addMember(data.store, cloudflareAccess(groupConfig(env)), data.user, b.email, b.admin, new Date()), 201);
};
