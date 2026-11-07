// Runs before every request to the site, its files included: see lib/gate.ts.
import { d1Store } from './lib/d1.ts';
import { config, gate, type Env } from './lib/gate.ts';
import type { Store, User } from './lib/users.ts';

export interface Data extends Record<string, unknown> {
	user: User;
	store: Store;
}

export const onRequest: PagesFunction<Env, string, Data> = async (ctx) => {
	const store = ctx.env.USERS_DB ? d1Store(ctx.env.USERS_DB) : null;
	const out = await gate(ctx.request, config(ctx.env), store);
	if (out instanceof Response) return out;
	ctx.data.user = out;
	ctx.data.store = store!;
	return ctx.next();
};
