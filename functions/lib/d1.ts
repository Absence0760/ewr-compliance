// The user list in Cloudflare D1. The schema is migrations/0001_users.sql. The last-admin rule is in
// each statement, so two admins acting at once cannot leave the site with none. A change and its audit
// row go in one batch, which D1 runs as a transaction, and the row is written only if the change was.
import type { Entry, Store, User } from './users.ts';

interface Row {
	email: string;
	admin: number;
	added_by: string;
	added_at: string;
}

const user = (r: Row): User => ({ email: r.email, admin: r.admin === 1, addedBy: r.added_by, addedAt: r.added_at });

/** True when the change keeps an admin: the user is not one, or another admin remains. */
const KEEPS_ADMIN = `(admin = 0 OR (SELECT COUNT(*) FROM users WHERE admin = 1) > 1)`;

export function d1Store(db: D1Database): Store {
	/** The change, then its entry if the change touched a row. True when it did. */
	async function change(stmt: D1PreparedStatement, entry?: Entry): Promise<boolean> {
		if (!entry) return (await stmt.run()).meta.changes === 1;
		const log = db
			.prepare('INSERT INTO audit (at, actor, action, target) SELECT ?, ?, ?, ? WHERE changes() = 1')
			.bind(entry.at, entry.actor, entry.action, entry.target);
		const [r] = await db.batch([stmt, log]);
		return r.meta.changes === 1;
	}

	return {
		async get(email) {
			const r = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<Row>();
			return r ? user(r) : null;
		},
		async list() {
			return (await db.prepare('SELECT * FROM users').all<Row>()).results.map(user);
		},
		insert: (u, entry) =>
			change(
				db
					.prepare('INSERT INTO users (email, admin, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
					.bind(u.email, u.admin ? 1 : 0, u.addedBy, u.addedAt),
				entry
			),
		setAdmin: (email, admin, entry) =>
			change(
				db.prepare(admin ? 'UPDATE users SET admin = 1 WHERE email = ?' : `UPDATE users SET admin = 0 WHERE email = ? AND ${KEEPS_ADMIN}`).bind(email),
				entry
			),
		remove: (email, entry) => change(db.prepare(`DELETE FROM users WHERE email = ? AND ${KEEPS_ADMIN}`).bind(email), entry)
	};
}
