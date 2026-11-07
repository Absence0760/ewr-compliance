// The Access group: whether the site keeps it in step with the list (GET), and sync it now (POST).
// Admins only; a POST, like every change, must come from the site's own origin (lib/gate.ts).
import { groupConfig, type GroupEnv } from '../../lib/accessGroup.ts';
import type { Env } from '../../lib/gate.ts';
import { reply } from '../../lib/http.ts';
import { accessStatus, cloudflareAccess, syncNow } from '../../lib/membership.ts';
import type { Data } from '../../_middleware.ts';

export const onRequestGet: PagesFunction<Env & GroupEnv, string, Data> = ({ data, env }) =>
	reply(accessStatus(cloudflareAccess(groupConfig(env)), data.user));

export const onRequestPost: PagesFunction<Env & GroupEnv, string, Data> = async ({ data, env }) =>
	reply(await syncNow(data.store, cloudflareAccess(groupConfig(env)), data.user));
