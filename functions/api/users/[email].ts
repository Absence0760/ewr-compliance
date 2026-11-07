// One user: make or unmake them an admin, or remove them, and then bring the Access group in step.
// Making or unmaking an admin leaves the group alone. Admins only.
import { groupConfig, type GroupEnv } from '../../lib/accessGroup.ts';
import type { Env } from '../../lib/gate.ts';
import { body, pathEmail, reply } from '../../lib/http.ts';
import { cloudflareAccess, removeMember } from '../../lib/membership.ts';
import { setAdmin } from '../../lib/users.ts';
import type { Data } from '../../_middleware.ts';

export const onRequestPatch: PagesFunction<Env, 'email', Data> = async ({ data, request, params }) =>
	reply(await setAdmin(data.store, data.user, pathEmail(params), (await body(request)).admin, new Date()));

export const onRequestDelete: PagesFunction<Env & GroupEnv, 'email', Data> = async ({ data, params, env }) =>
	reply(await removeMember(data.store, cloudflareAccess(groupConfig(env)), data.user, pathEmail(params), new Date()));
