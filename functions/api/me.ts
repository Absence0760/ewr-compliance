// Who is signed in, so the app can show the user page to admins.
import { json, type Env } from '../lib/gate.ts';
import type { Data } from '../_middleware.ts';

export const onRequestGet: PagesFunction<Env, string, Data> = ({ data }) => json({ email: data.user.email, admin: data.user.admin });
