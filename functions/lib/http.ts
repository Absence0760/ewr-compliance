// Replies and request bodies for the api/ functions.
import { json } from './gate.ts';
import type { Result } from './users.ts';

export const reply = <T>(r: Result<T>, status = 200) => (r.ok ? json(r.value, status) : json({ error: r.error }, r.status));

/** The JSON object sent, or an empty one, which the rules then refuse field by field. */
export async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const b = await req.json();
		return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The [email] in the path, which the app sends encoded. */
export function pathEmail(params: Record<string, string | string[]>): string {
	const raw = typeof params.email === 'string' ? params.email : '';
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
